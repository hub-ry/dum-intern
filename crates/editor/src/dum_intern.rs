use crate::{
    Editor, SelectionEffects,
    code_context_menus::CodeContextMenu,
    display_map::{BlockPlacement, BlockProperties, BlockStyle, CustomBlockId, HighlightKey},
};
use gpui::{App, Context, Entity, IntoElement, Subscription, Task, Window, actions};
use language::{Buffer, BufferEditSource, CursorShape, Point, Selection, SelectionGoal};
use multi_buffer::ToPoint as _;
use std::{sync::Arc, time::Duration};
use text::{Anchor, ToOffset as _, ToPoint as _, TransactionId};
use ui::{Button, ButtonStyle, Label, LabelSize, prelude::*};
use unicode_segmentation::UnicodeSegmentation;
use util::ResultExt;

actions!(dum_intern, [Run]);

const PACE: Duration = Duration::from_millis(65);
const DONE_NOTICE_DURATION: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Typing,
    Paused,
    Changed,
    Done,
    Stopped,
    NeedsYou,
    Planning,
}

pub(super) struct Playback {
    pub(super) name: String,
    message: String,
    buffer: Entity<Buffer>,
    start: Anchor,
    end: Anchor,
    expected: String,
    remaining: Vec<String>,
    next: usize,
    state: State,
    transaction: Option<TransactionId>,
    block: Option<CustomBlockId>,
    task: Task<()>,
    notice_task: Option<Task<()>>,
    _release: Subscription,
}

impl Playback {
    pub(super) fn is_typing(&self) -> bool {
        self.state == State::Typing
    }

    fn matches(&self, cx: &App) -> bool {
        let buffer = self.buffer.read(cx);
        buffer.can_resolve(&self.start)
            && buffer.can_resolve(&self.end)
            && buffer
                .text_for_range(self.start..self.end)
                .collect::<String>()
                == self.expected
    }

    fn clear_cursor(&self, cx: &mut App) {
        self.buffer
            .update(cx, |buffer, cx| buffer.remove_agent_selections(cx));
    }
}

impl Editor {
    pub(super) fn can_compose_intern_assignment(&self, cx: &mut App) -> bool {
        if !self.mode.is_full() || self.read_only(cx) || self.pending_inline_input.is_some() {
            return false;
        }
        let snapshot = self.buffer.read(cx).snapshot(cx);
        let selections = self.selections.all::<Point>(&self.display_snapshot(cx));
        if selections.len() != 1 {
            return false;
        }
        let selection = &selections[0];
        selection.is_empty()
            && self.buffer.read(cx).as_singleton().is_some()
            && snapshot
                .chars_at(Point::new(selection.head().row, 0))
                .take_while(|character| *character != '\n')
                .all(char::is_whitespace)
    }

    pub(super) fn compose_intern_assignment(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_compose_intern_assignment(cx) {
            return;
        }
        let Some(buffer) = self.buffer.read(cx).as_singleton() else {
            return;
        };
        let display = self.display_snapshot(cx);
        let point = Point::new(self.selections.newest::<Point>(&display).head().row, 0);
        let line: String = buffer
            .read(cx)
            .chars_at(point)
            .take_while(|character| *character != '\n')
            .collect();
        let snapshot = buffer.read(cx).snapshot();
        let start = snapshot.anchor_before(point);
        let end = snapshot.anchor_after(Point::new(point.row, line.len() as u32));
        let position = self.buffer.read(cx).snapshot(cx).anchor_before(point);
        self.show_inline_input(
            "@intern what should I work on?",
            position,
            None,
            Vec::new(),
            move |editor, request, window, cx| {
                let (name, request) = parse_mention(&request)?;
                if request.is_empty() {
                    return None;
                }
                let intern = crate::interns::profile(name, cx)?;
                editor.take_inline_input(window, cx);
                let snapshot = buffer.read(cx).snapshot();
                if !snapshot.can_resolve(&start)
                    || !snapshot.can_resolve(&end)
                    || snapshot.text_for_range(start..end).collect::<String>() != line
                {
                    return None;
                }
                let point = start.to_point(&snapshot);
                editor.start_intern_assignment(
                    buffer.clone(),
                    point,
                    line.clone(),
                    intern,
                    request.trim().to_owned(),
                    window,
                    cx,
                );
                None
            },
            |editor, _, window, cx| {
                editor.refresh_intern_mention(window, cx);
                None
            },
            window,
            cx,
        );
        let Some(input) = self.pending_inline_input.as_ref() else {
            return;
        };
        let block_id = input.block_id;
        let input = input.editor.clone();
        self.remove_blocks([block_id].into_iter().collect(), None, cx);
        let blocks = self.insert_blocks(
            [BlockProperties {
                placement: BlockPlacement::ReplaceLine(position),
                height: Some(1),
                style: BlockStyle::Sticky,
                priority: 0,
                render: Arc::new(move |block| {
                    let text = input.read(block.app).text(block.app);
                    let mention = parse_mention(&text).and_then(|(name, _)| {
                        crate::interns::mention_profiles(block.app)
                            .into_iter()
                            .find(|(candidate, _)| candidate == name)
                    });
                    h_flex()
                        .w_full()
                        .h(block.line_height)
                        .gap_1()
                        .pl(block.anchor_x)
                        .pr_2()
                        .when_some(mention, |row, (_, appearance)| {
                            row.child(
                                ui::Icon::from_path(appearance.shape.path())
                                    .size(ui::IconSize::Small)
                                    .color(ui::Color::Custom(appearance.color.value())),
                            )
                        })
                        .child(gpui::div().flex_1().min_w_0().h_full().child(
                            crate::EditorElement::new(
                                &input,
                                crate::EditorStyle {
                                    background: block.app.theme().system().transparent,
                                    local_player: block.editor_style.local_player,
                                    text: block.editor_style.text.clone(),
                                    scrollbar_width: block.editor_style.scrollbar_width,
                                    syntax: block.editor_style.syntax.clone(),
                                    status: block.editor_style.status.clone(),
                                    ..crate::EditorStyle::default()
                                },
                            ),
                        ))
                        .into_any_element()
                }),
            }],
            None,
            cx,
        );
        let text_style = self.create_style(cx).text;
        if let Some(state) = self.pending_inline_input.as_mut() {
            if let Some(block) = blocks.first() {
                state.block_id = *block;
            }
            state.editor.update(cx, |input, cx| {
                input.set_text_style_refinement(gpui::TextStyleRefinement {
                    font_family: Some(text_style.font_family.clone()),
                    font_features: Some(text_style.font_features.clone()),
                    font_fallbacks: text_style.font_fallbacks.clone(),
                    font_size: Some(text_style.font_size),
                    font_weight: Some(text_style.font_weight),
                    line_height: Some(text_style.line_height),
                    ..Default::default()
                });
                input.set_text("@", window, cx);
                input.change_selections(SelectionEffects::no_scroll(), window, cx, |selections| {
                    selections.select_ranges([Point::new(0, 1)..Point::new(0, 1)])
                });
            });
        }
        self.refresh_intern_mention(window, cx);
        cx.notify();
    }

    fn refresh_intern_mention(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self
            .pending_inline_input
            .as_ref()
            .map(|state| state.editor.clone())
        else {
            return;
        };
        let profiles = crate::interns::mention_profiles(cx);
        input.update(cx, |input, cx| {
            let text = input.text(cx);
            let snapshot = input.buffer.read(cx).snapshot(cx);
            input.clear_highlights(HighlightKey::DumInternMention, cx);
            if let Some((name, _)) = parse_mention(&text) {
                input.hide_context_menu(window, cx);
                if let Some((_, appearance)) =
                    profiles.iter().find(|(candidate, _)| candidate == name)
                {
                    let end = text.find(char::is_whitespace).unwrap_or(text.len());
                    input.highlight_text(
                        HighlightKey::DumInternMention,
                        vec![
                            snapshot.anchor_before(Point::new(0, 0))
                                ..snapshot.anchor_after(Point::new(0, end as u32)),
                        ],
                        gpui::HighlightStyle {
                            color: Some(appearance.color.value()),
                            ..Default::default()
                        },
                        cx,
                    );
                }
            } else if let Some(query) = text
                .strip_prefix('@')
                .filter(|query| !query.chars().any(char::is_whitespace))
            {
                let query = query.to_ascii_lowercase();
                let choices: Vec<String> = profiles
                    .iter()
                    .filter(|(name, _)| name.to_ascii_lowercase().contains(&query))
                    .map(|(name, _)| format!("@{name} "))
                    .collect();
                if choices.is_empty() {
                    input.hide_context_menu(window, cx);
                } else {
                    let range = snapshot.anchor_before(Point::new(0, 0))
                        ..snapshot.anchor_after(Point::new(0, text.len() as u32));
                    input.hide_context_menu(window, cx);
                    input.show_snippet_choices(&choices, range, cx);
                    if let Some(CodeContextMenu::Completions(menu)) =
                        input.context_menu.borrow_mut().as_mut()
                    {
                        for completion in menu.completions.borrow_mut().iter_mut() {
                            completion.new_text =
                                completion.new_text.trim_start_matches('@').to_owned();
                            if let Some((_, appearance)) = profiles
                                .iter()
                                .find(|(name, _)| completion.new_text.trim_end() == name)
                            {
                                completion.icon_path = Some(appearance.shape.path().into());
                                completion.icon_color = Some(appearance.color.value());
                            }
                        }
                    }
                }
            } else {
                input.hide_context_menu(window, cx);
            }
            cx.notify();
        });
        cx.notify();
    }

    pub(super) fn dum_intern_assignment(
        &self,
        cx: &mut App,
    ) -> Option<(Entity<Buffer>, Point, String)> {
        if !self.mode.is_full() || self.read_only(cx) {
            return None;
        }
        let buffer = self.buffer.read(cx).as_singleton()?;
        let snapshot = self.display_snapshot(cx);
        let row = self.selections.newest::<Point>(&snapshot).head().row;
        let point = Point::new(row, 0);
        let line: String = buffer
            .read(cx)
            .chars_at(point)
            .take_while(|character| *character != '\n')
            .collect();
        let (_, _, request) = parse_assignment(&line)?;
        if request.is_empty() {
            return None;
        }
        Some((buffer, point, line))
    }

    pub(super) fn run_dum_intern(&mut self, _: &Run, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .dum_intern
            .as_ref()
            .is_some_and(|playback| playback.state == State::Planning)
        {
            return;
        }
        if self
            .dum_intern
            .as_ref()
            .is_some_and(|playback| matches!(playback.state, State::Typing | State::Paused))
        {
            self.resume_dum_intern(window, cx);
            return;
        }
        let Some((buffer, point, line)) = self.dum_intern_assignment(cx) else {
            self.compose_intern_assignment(window, cx);
            return;
        };
        let Some((_, name, request)) = parse_assignment(&line) else {
            return;
        };
        let Some(intern) = crate::interns::profile(name, cx) else {
            return;
        };
        let request = request.to_owned();
        self.start_intern_assignment(buffer, point, line, intern, request, window, cx);
    }

    fn start_intern_assignment(
        &mut self,
        buffer: Entity<Buffer>,
        point: Point,
        line: String,
        intern: crate::interns::Intern,
        request: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(previous) = self.dum_intern.take() {
            previous.clear_cursor(cx);
            if let Some(block) = previous.block {
                self.remove_blocks([block].into_iter().collect(), None, cx);
            }
        }
        let indent: String = line
            .chars()
            .take_while(|character| character.is_whitespace())
            .collect();
        let preview = matches!(request.as_str(), "demo" | "frontend-demo");
        let (mut reply, message) = if preview {
            scripted_reply(&request, &indent, &intern)
        } else {
            (String::new(), "Preparing an insertion".into())
        };
        if !reply.is_empty() {
            if !line.trim().is_empty() {
                reply.insert(0, '\n');
            } else {
                reply = reply.strip_prefix(&indent).unwrap_or(&reply).to_owned();
            }
        }
        let state = if !preview {
            State::Planning
        } else if reply.is_empty() {
            State::NeedsYou
        } else {
            State::Typing
        };
        let snapshot = buffer.read(cx).snapshot();
        let end_point = Point::new(point.row, line.len() as u32);
        let start = snapshot.anchor_before(point);
        let end = snapshot.anchor_after(end_point);
        let placement = self.buffer.read(cx).snapshot(cx).anchor_before(point);
        self.dum_intern = Some(Playback {
            name: intern.name.clone(),
            message,
            buffer,
            start,
            end,
            expected: line,
            remaining: reply.graphemes(true).map(str::to_owned).collect(),
            next: 0,
            state,
            transaction: None,
            block: None,
            task: Task::ready(()),
            notice_task: None,
            _release: cx.on_release(|editor, cx| {
                if let Some(playback) = &editor.dum_intern {
                    playback.clear_cursor(cx);
                }
            }),
        });
        let editor = cx.entity().downgrade();
        let blocks = self.insert_blocks(
            [BlockProperties {
                placement: BlockPlacement::Above(placement),
                height: Some(2),
                style: BlockStyle::Sticky,
                priority: 0,
                render: Arc::new(move |block| {
                    let Some(editor) = editor.upgrade() else {
                        return gpui::div().into_any_element();
                    };
                    let state = editor
                        .read(block.app)
                        .dum_intern
                        .as_ref()
                        .map(|playback| playback.state);
                    let label = match state {
                        Some(State::Typing) => "Typing",
                        Some(State::Paused) => "Paused - resume when ready",
                        Some(State::Changed) => "You changed this block - stopped",
                        Some(State::Done) => "Done",
                        Some(State::NeedsYou) => "TODO @you",
                        Some(State::Planning) => "Thinking",
                        _ => "Stopped",
                    };
                    let pause_editor = editor.downgrade();
                    let stop_editor = editor.downgrade();
                    let undo_editor = editor.downgrade();
                    let description = format!(
                        "@{} · {label} · {}",
                        editor
                            .read(block.app)
                            .dum_intern
                            .as_ref()
                            .map(|playback| playback.name.as_str())
                            .unwrap_or("intern"),
                        editor
                            .read(block.app)
                            .dum_intern
                            .as_ref()
                            .map(|playback| playback.message.as_str())
                            .unwrap_or("")
                    );
                    let tooltip = description.clone();
                    h_flex()
                        .w_full()
                        .h_full()
                        .gap_2()
                        .pl(block.anchor_x)
                        .pr_2()
                        .child(
                            gpui::div()
                                .id("intern-status-message")
                                .flex_1()
                                .min_w_0()
                                .tooltip(ui::Tooltip::text(tooltip.clone()))
                                .child(Label::new(description).size(LabelSize::Small).truncate()),
                        )
                        .when(
                            matches!(state, Some(State::Typing | State::Paused)),
                            |row| {
                                row.child(
                                    Button::new(
                                        "dum-pause",
                                        if state == Some(State::Typing) {
                                            "Pause"
                                        } else {
                                            "Resume"
                                        },
                                    )
                                    .style(ButtonStyle::Subtle)
                                    .on_click(
                                        move |_, window, cx| {
                                            pause_editor
                                                .update(cx, |editor, cx| {
                                                    if editor.dum_intern.as_ref().is_some_and(
                                                        |playback| playback.state == State::Typing,
                                                    ) {
                                                        editor.pause_dum_intern(cx);
                                                    } else {
                                                        editor.focus_handle.focus(window, cx);
                                                        editor.resume_dum_intern(window, cx);
                                                    }
                                                })
                                                .log_err();
                                        },
                                    ),
                                )
                                .child(
                                    Button::new("dum-stop", "Stop")
                                        .style(ButtonStyle::Subtle)
                                        .on_click(move |_, _, cx| {
                                            stop_editor
                                                .update(cx, |editor, cx| {
                                                    editor.stop_dum_intern(State::Stopped, cx)
                                                })
                                                .log_err();
                                        }),
                                )
                            },
                        )
                        .when(state == Some(State::Planning), |row| {
                            let editor = editor.downgrade();
                            row.child(Button::new("intern-cancel-request", "Stop").on_click(
                                move |_, _, cx| {
                                    editor
                                        .update(cx, |editor, cx| {
                                            editor.stop_dum_intern(State::Stopped, cx)
                                        })
                                        .log_err();
                                },
                            ))
                        })
                        .child(
                            Button::new(
                                "dum-undo",
                                if matches!(state, Some(State::Planning | State::NeedsYou)) {
                                    "Dismiss"
                                } else {
                                    "Undo dum"
                                },
                            )
                            .style(ButtonStyle::Subtle)
                            .disabled(state == Some(State::Changed))
                            .on_click(move |_, _, cx| {
                                undo_editor
                                    .update(cx, |editor, cx| editor.undo_dum_intern(cx))
                                    .log_err();
                            }),
                        )
                        .into_any_element()
                }),
            }],
            None,
            cx,
        );
        if let Some(playback) = self.dum_intern.as_mut() {
            playback.block = blocks.first().copied();
        }
        if state == State::Typing {
            self.resume_dum_intern(window, cx);
        } else if state == State::Planning {
            let Some(playback) = self.dum_intern.as_ref() else {
                return;
            };
            let snapshot = playback.buffer.read(cx).snapshot();
            let first_row = point.row.saturating_sub(80);
            let context: String = snapshot
                .text()
                .lines()
                .enumerate()
                .filter(|(row, _)| {
                    *row >= first_row as usize && *row <= point.row.saturating_add(80) as usize
                })
                .map(|(row, line)| {
                    if row == point.row as usize {
                        format!("{line}/* INSERT HERE */\n")
                    } else {
                        format!("{line}\n")
                    }
                })
                .collect::<String>()
                .chars()
                .take(32000)
                .collect();
            let buffer = playback.buffer.read(cx);
            let language = buffer
                .language()
                .map(|language| language.name().to_string());
            let path = buffer
                .file()
                .map(|file| file.full_path(cx).display().to_string());
            let context = serde_json::json!({"file": path, "language": language, "insertion_row": point.row, "code": context}).to_string();
            let task = cx.spawn_in(window, async move |editor, cx| {
                let result = crate::intern_model::complete(intern, request, context, cx).await;
                editor
                    .update_in(cx, |editor, window, cx| {
                        editor.finish_intern_completion(result, window, cx);
                    })
                    .log_err();
            });
            if let Some(playback) = self.dum_intern.as_mut() {
                playback.task = task;
            }
        }
        cx.notify();
    }

    fn finish_intern_completion(
        &mut self,
        result: anyhow::Result<crate::intern_model::Completion>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(playback) = self.dum_intern.as_ref() else {
            return;
        };
        if playback.state != State::Planning {
            return;
        }
        if self.read_only(cx) || !playback.matches(cx) {
            self.stop_dum_intern(State::Changed, cx);
            return;
        }
        let Some(playback) = self.dum_intern.as_mut() else {
            return;
        };
        match result {
            Ok(completion) => {
                let mut code = completion.code;
                if playback.expected.trim().is_empty() {
                    code = code
                        .strip_prefix(&playback.expected)
                        .unwrap_or(&code)
                        .to_owned();
                } else {
                    code.insert(0, '\n');
                }
                playback.remaining = code.graphemes(true).map(str::to_owned).collect();
                playback.next = 0;
                playback.message = "Generated with your configured model".into();
                playback.state = State::Paused;
                self.resume_dum_intern(window, cx);
            }
            Err(error) => {
                playback.message = format!("{error:#}");
                playback.state = State::NeedsYou;
                cx.notify();
            }
        }
    }

    fn resume_dum_intern(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(playback) = self.dum_intern.as_mut() else {
            return;
        };
        if !matches!(playback.state, State::Typing | State::Paused) || !playback.matches(cx) {
            self.stop_dum_intern(State::Changed, cx);
            return;
        }
        playback.state = State::Typing;
        playback.task = cx.spawn_in(window, async move |editor, cx| {
            loop {
                cx.background_executor().timer(PACE).await;
                match editor.update_in(cx, |editor, window, cx| editor.tick_dum_intern(window, cx))
                {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        log::debug!("dum-intern editor closed: {error}");
                        break;
                    }
                }
            }
        });
        cx.notify();
    }

    fn tick_dum_intern(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(mut playback) = self.dum_intern.take() else {
            return false;
        };
        if playback.state != State::Typing {
            self.dum_intern = Some(playback);
            return false;
        }
        let visible = if self.visible_line_count().is_some() {
            let display = self.display_snapshot(cx);
            let rows = self.multi_buffer_visible_range(&display, cx);
            let point = playback.end.to_point(playback.buffer.read(cx));
            point >= rows.start && point <= rows.end
        } else {
            true
        };
        if !self.is_focused(window) || !window.is_window_active() || !visible {
            playback.state = State::Paused;
        } else if self.read_only(cx) || !playback.matches(cx) {
            playback.state = State::Changed;
        } else if let Some(character) = playback.remaining.get(playback.next).cloned() {
            let insertion = playback.end;
            let display = self.display_snapshot(cx);
            let point = insertion.to_point(playback.buffer.read(cx));
            let mut selections = self.selections.all_anchors(&display).to_vec();
            let mut preserve_selection = false;
            // Keep a human cursor at the insertion boundary on its original side.
            for selection in &mut selections {
                if selection.start.to_point(display.buffer_snapshot()) == point {
                    selection.start = display.buffer_snapshot().anchor_before(point);
                    preserve_selection = true;
                }
                if selection.end.to_point(display.buffer_snapshot()) == point {
                    selection.end = display.buffer_snapshot().anchor_before(point);
                    preserve_selection = true;
                }
            }
            let transaction = playback.buffer.update(cx, |buffer, cx| {
                buffer.finalize_last_transaction();
                buffer.start_transaction();
                buffer.edit([(insertion..insertion, character.clone())], None, cx);
                let transaction = buffer.end_transaction_with_source(BufferEditSource::Agent, cx);
                buffer.finalize_last_transaction();
                if let Some(previous) = playback.transaction {
                    if let Some(transaction) = transaction {
                        // Merge only dum's edits, leaving interleaved human edits separate.
                        buffer.merge_transactions(transaction, previous);
                    }
                }
                let cursor = buffer.anchor_after(insertion.to_offset(buffer));
                buffer.set_agent_selections(
                    Arc::from([Selection {
                        id: 0,
                        start: cursor,
                        end: cursor,
                        reversed: false,
                        goal: SelectionGoal::None,
                    }]),
                    false,
                    CursorShape::Bar,
                    cx,
                );
                transaction
            });
            if preserve_selection {
                self.change_selections(SelectionEffects::no_scroll(), window, cx, |collection| {
                    collection.select_anchors(selections);
                });
            }
            if playback.transaction.is_none() {
                if let Some(transaction) = transaction {
                    self.selection_history.insert_transaction(
                        transaction,
                        self.selections.disjoint_anchors_arc(),
                        self.add_selections_state.clone(),
                    );
                }
                playback.transaction = transaction;
            }
            if let Some(transaction) = playback
                .transaction
                .and_then(|transaction| self.selection_history.transaction_mut(transaction))
            {
                transaction.redo = Some(self.selections.disjoint_anchors_arc());
                transaction.redo_add_selections_state = self.add_selections_state.clone();
            }
            playback.expected.push_str(&character);
            playback.next += 1;
            if playback.next == playback.remaining.len() {
                playback.state = State::Done;
            }
        }
        let running = playback.state == State::Typing;
        if !running {
            playback.clear_cursor(cx);
        }
        let completed_block = (playback.state == State::Done)
            .then_some(playback.block)
            .flatten();
        self.dum_intern = Some(playback);
        if let Some(block) = completed_block {
            let task = cx.spawn(async move |editor, cx| {
                cx.background_executor().timer(DONE_NOTICE_DURATION).await;
                editor
                    .update(cx, |editor, cx| {
                        if editor.dum_intern.as_ref().is_some_and(|playback| {
                            playback.state == State::Done && playback.block == Some(block)
                        }) {
                            editor.dismiss_completed_intern_notice(cx);
                        }
                    })
                    .log_err();
            });
            if let Some(playback) = self.dum_intern.as_mut() {
                playback.notice_task = Some(task);
            }
        }
        cx.notify();
        running
    }

    fn pause_dum_intern(&mut self, cx: &mut Context<Self>) {
        self.stop_dum_intern(State::Paused, cx);
    }

    fn stop_dum_intern(&mut self, state: State, cx: &mut Context<Self>) {
        if let Some(playback) = self.dum_intern.as_mut() {
            playback.state = state;
            playback.task = Task::ready(());
            playback.clear_cursor(cx);
        }
        cx.notify();
    }

    fn dismiss_completed_intern_notice(&mut self, cx: &mut Context<Self>) {
        if let Some(block) = self
            .dum_intern
            .as_mut()
            .and_then(|playback| playback.block.take())
        {
            self.remove_blocks([block].into_iter().collect(), None, cx);
            cx.notify();
        }
    }

    pub(super) fn check_dum_intern_target(&mut self, cx: &mut Context<Self>) {
        if self
            .dum_intern
            .as_ref()
            .is_some_and(|playback| playback.state == State::Done)
        {
            self.dismiss_completed_intern_notice(cx);
            return;
        }
        if self.dum_intern.as_ref().is_some_and(|playback| {
            matches!(
                playback.state,
                State::Typing | State::Paused | State::Planning
            ) && !playback.matches(cx)
        }) {
            self.stop_dum_intern(State::Changed, cx);
        }
    }

    fn undo_dum_intern(&mut self, cx: &mut Context<Self>) {
        let Some(playback) = self.dum_intern.as_ref() else {
            return;
        };
        if !playback.matches(cx) {
            self.stop_dum_intern(State::Changed, cx);
            return;
        }
        self.stop_dum_intern(State::Stopped, cx);
        if let Some(playback) = self.dum_intern.take() {
            if let Some(transaction) = playback.transaction {
                playback.buffer.update(cx, |buffer, cx| {
                    buffer.undo_transaction(transaction, cx);
                });
            }
            if let Some(block) = playback.block {
                self.remove_blocks([block].into_iter().collect(), None, cx);
            }
        }
        cx.notify();
    }
}

fn parse_mention(text: &str) -> Option<(&str, &str)> {
    let (name, request) = text.split_once(char::is_whitespace)?;
    let name = name.strip_prefix('@').unwrap_or(name);
    if name.is_empty() {
        return None;
    }
    Some((name, request.trim()))
}

fn parse_assignment(line: &str) -> Option<(&str, &str, &str)> {
    let trimmed = line.trim_start();
    let indent = line.get(..line.len() - trimmed.len())?;
    let (name, request) = trimmed.strip_prefix("// @")?.split_once(':')?;
    Some((indent, name, request.trim()))
}

fn scripted_reply(
    request: &str,
    indent: &str,
    intern: &crate::interns::Intern,
) -> (String, String) {
    let required = match request {
        "demo" => vec![],
        "frontend-demo" => vec!["frontend"],
        _ => {
            return (
                String::new(),
                "Model execution is not connected yet.".into(),
            );
        }
    };
    let missing = intern.missing_skills(required);
    if !missing.is_empty() {
        return (
            String::new(),
            format!(
                "Missing skills: {}. Import a skill or show me an example.",
                missing.join(", ")
            ),
        );
    }
    let code = if request == "frontend-demo" {
        format!(
            "{indent}function Greeting({{ name }}) {{\n{indent}  return <h1>Hello, {{name}}!</h1>;\n{indent}}}"
        )
    } else {
        format!(
            "{indent}function greet(name) {{\n{indent}  return `Hello, ${{name}}!`;\n{indent}}}"
        )
    };
    (code, "Scripted preview".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test::editor_test_context::EditorTestContext;
    use gpui::TestAppContext;

    fn tick(context: &mut EditorTestContext) {
        context.update(|window, _| window.activate_window());
        context.run_until_parked();
        context.update_editor(|editor, window, cx| {
            editor.tick_dum_intern(window, cx);
        });
    }

    fn assign(context: &mut EditorTestContext, request: &str) {
        context.update_editor(|editor, window, cx| editor.handle_input("@", window, cx));
        context.update_editor(|editor, window, cx| {
            let input = editor
                .pending_inline_input()
                .expect("native mention composer")
                .editor
                .clone();
            input.update(cx, |input, cx| {
                input.set_text(format!("dum-intern {request}"), window, cx)
            });
            editor.confirm_inline_input(window, cx);
        });
    }

    fn model_connection(
        context: &mut EditorTestContext,
    ) -> (
        Arc<language_model::fake_provider::FakeLanguageModelProvider>,
        language_model::LanguageModel,
    ) {
        let provider =
            Arc::new(language_model::fake_provider::FakeLanguageModelProvider::default());
        let model = provider.model("fake");
        let factory_provider = provider.clone();
        context.update(|_, cx| {
            cx.set_global(crate::intern_model::InternModelFactory(Arc::new(
                move |_, _| Ok(factory_provider.clone()),
            )))
        });
        (provider, model)
    }

    #[gpui::test]
    async fn done_notice_expires_without_changing_code_or_undo(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("ˇ\n");
        assign(&mut context, "demo");
        for _ in 0..200 {
            tick(&mut context);
        }
        let code = context.buffer_text();
        context.editor(|editor, _, _| {
            let playback = editor.dum_intern.as_ref().expect("completed playback");
            assert!(playback.state == State::Done);
            assert!(playback.block.is_some());
        });
        context.cx.executor().advance_clock(DONE_NOTICE_DURATION);
        context.run_until_parked();
        context.editor(|editor, _, _| {
            assert!(
                editor
                    .dum_intern
                    .as_ref()
                    .expect("playback")
                    .block
                    .is_none()
            )
        });
        assert_eq!(context.buffer_text(), code);
        context.update_editor(|editor, _, cx| editor.undo_dum_intern(cx));
        assert_eq!(context.buffer_text(), "\n");
    }

    #[gpui::test]
    async fn deleting_completed_code_removes_its_notice_immediately(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("ˇ\n");
        assign(&mut context, "demo");
        for _ in 0..200 {
            tick(&mut context);
        }
        context.update_buffer(|buffer, cx| {
            buffer.edit([(0..buffer.len(), "")], None, cx);
        });
        context.run_until_parked();
        context.editor(|editor, _, _| {
            assert!(
                editor
                    .dum_intern
                    .as_ref()
                    .expect("playback")
                    .block
                    .is_none()
            )
        });
        assert_eq!(context.buffer_text(), "");
    }

    #[gpui::test]
    async fn intern_composer_replaces_empty_line_at_its_original_row(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("const before = 1;\nˇ\nconst after = 2;");
        context.update_editor(|editor, window, cx| {
            editor.handle_input("@", window, cx);
            let block = editor
                .pending_inline_input()
                .expect("mention input")
                .block_id;
            assert!(
                editor.row_for_block(block, cx).is_some(),
                "empty-line replacement must be rendered"
            );
            assert_eq!(
                editor.display_snapshot(cx).text(),
                "const before = 1;\n\nconst after = 2;"
            );
            editor.take_inline_input(window, cx);
        });
        assert_eq!(
            context.buffer_text(),
            "const before = 1;\n\nconst after = 2;"
        );
        context.set_state("ˇ");
        context.update_editor(|editor, window, cx| {
            editor.handle_input("@", window, cx);
            let block = editor
                .pending_inline_input()
                .expect("empty-file mention")
                .block_id;
            assert!(editor.row_for_block(block, cx).is_some());
            editor.take_inline_input(window, cx);
        });
        assert_eq!(context.buffer_text(), "");
    }

    #[gpui::test]
    async fn mention_picker_filters_and_inserts_a_colored_name_before_the_request(
        cx: &mut TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        cx.update(|cx| {
            let bindings = settings::KeymapFile::load_asset_allow_partial_failure(
                "keymaps/default-macos.json",
                cx,
            )
            .expect("default macOS keymap");
            cx.bind_keys(bindings);
        });
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("ˇ\nconst yours = 1;\n");
        context.update_editor(|editor, window, cx| editor.handle_input("@", window, cx));
        context.run_until_parked();
        let input = context.editor(|editor, _, _| {
            editor
                .pending_inline_input()
                .expect("mention input")
                .editor
                .clone()
        });
        context.update(|window, cx| {
            input.update(cx, |input, cx| input.handle_input("du", window, cx))
        });
        context.run_until_parked();
        context.update(|_, cx| {
            input.update(cx, |input, cx| {
                assert_eq!(input.text(cx), "@du");
                {
                    let menu = input.context_menu.borrow();
                    let Some(CodeContextMenu::Completions(menu)) = menu.as_ref() else {
                        panic!("intern suggestions");
                    };
                    assert_eq!(menu.completions.borrow().len(), 1);
                }
            })
        });
        context.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
        context.simulate_keystroke("tab");
        context.run_until_parked();
        context.update(|window, cx| {
            input.update(cx, |input, cx| {
                assert_eq!(input.text(cx), "dum-intern ");
                assert!(
                    input
                        .text_highlights(HighlightKey::DumInternMention, cx)
                        .is_some()
                );
                input.handle_input("demo", window, cx);
            })
        });
        context.run_until_parked();
        assert_eq!(context.buffer_text(), "\nconst yours = 1;\n");
        context.update_editor(|editor, window, cx| editor.confirm_inline_input(window, cx));
        for _ in 0..100 {
            tick(&mut context);
        }
        assert!(context.buffer_text().contains("function greet(name)"));
        assert!(!context.buffer_text().contains("dum-intern"));
    }

    #[gpui::test]
    async fn unknown_mention_does_not_dispatch_an_assignment(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("ˇ\n");
        context.update_editor(|editor, window, cx| {
            editor.handle_input("@", window, cx);
            let input = editor
                .pending_inline_input()
                .expect("mention input")
                .editor
                .clone();
            input.update(cx, |input, cx| input.set_text("@unknown demo", window, cx));
            editor.confirm_inline_input(window, cx);
            assert!(editor.dum_intern.is_none());
            assert!(editor.pending_inline_input().is_some());
        });
        assert_eq!(context.buffer_text(), "\n");
    }

    #[gpui::test]
    async fn model_response_is_validated_then_typed_in_the_editor(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.update(|_, cx| {
            crate::interns::set_test_policy(crate::interns::SkillPolicy::Unrestricted, cx)
        });
        let (provider, model) = model_connection(&mut context);
        context.set_state("ˇ\nconst yours = 1;\n");
        assign(&mut context, "add a double function");
        context.run_until_parked();
        assert_eq!(provider.completion_count(), 1);
        assert_eq!(context.buffer_text(), "\nconst yours = 1;\n");
        provider.send_last_text(&model, r#"{"required_skills":["javascript"],"code":"function double(value) { return value * 2; }","todo":null}"#);
        provider.end_last(&model);
        context.run_until_parked();
        for _ in 0..100 {
            tick(&mut context);
        }
        assert!(context.buffer_text().contains("function double(value)"));
        assert!(context.buffer_text().contains("const yours = 1;"));
        assert!(!context.buffer_text().contains("function greet"));
    }

    #[gpui::test]
    async fn model_cannot_edit_with_missing_skills(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.update(|_, cx| {
            crate::interns::import_test_skill(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../demo/skills/frontend.md")
                    .as_path(),
                cx,
            )
        });
        let (provider, model) = model_connection(&mut context);
        context.set_state("ˇ\n");
        assign(&mut context, "create a database connection");
        context.run_until_parked();
        provider.send_last_text(
            &model,
            r#"{"required_skills":["database"],"code":"connectDatabase();","todo":null}"#,
        );
        provider.end_last(&model);
        context.run_until_parked();
        for _ in 0..50 {
            tick(&mut context);
        }
        assert_eq!(context.buffer_text(), "\n");
        context.editor(|editor, _, _| {
            let playback = editor.dum_intern.as_ref().expect("blocked model response");
            assert!(playback.state == State::NeedsYou);
            assert!(playback.message.contains("database"));
        });
    }

    #[gpui::test]
    async fn stopped_model_request_cannot_apply_a_queued_response(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.update(|_, cx| {
            crate::interns::set_test_policy(crate::interns::SkillPolicy::Unrestricted, cx)
        });
        let (provider, model) = model_connection(&mut context);
        context.set_state("ˇ\n");
        assign(&mut context, "write a function");
        context.run_until_parked();
        provider.send_last_text(
            &model,
            r#"{"required_skills":["javascript"],"code":"function late() {}","todo":null}"#,
        );
        provider.end_last(&model);
        context.update_editor(|editor, _, cx| editor.stop_dum_intern(State::Stopped, cx));
        context.run_until_parked();
        for _ in 0..50 {
            tick(&mut context);
        }
        assert_eq!(context.buffer_text(), "\n");
    }

    #[gpui::test]
    async fn native_mention_does_not_write_a_comment_and_restricted_tasks_leave_inline_todos(
        cx: &mut TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("ˇ\nconst yours = 1;\n");
        assign(&mut context, "frontend-demo");
        assert_eq!(context.buffer_text(), "\nconst yours = 1;\n");
        context.editor(|editor, _, _| {
            let playback = editor.dum_intern.as_ref().expect("inline TODO");
            assert!(playback.state == State::NeedsYou);
            assert!(playback.message.contains("frontend"));
        });
    }

    #[gpui::test]
    async fn unrestricted_intern_runs_unfamiliar_demo_without_source_mentions(
        cx: &mut TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.update(|_, cx| {
            crate::interns::set_test_policy(crate::interns::SkillPolicy::Unrestricted, cx)
        });
        context.set_state("ˇ\n");
        assign(&mut context, "frontend-demo");
        for _ in 0..160 {
            tick(&mut context);
        }
        assert!(context.buffer_text().contains("function Greeting"));
        assert!(!context.buffer_text().contains("//"));
    }

    #[gpui::test]
    async fn imported_skill_unlocks_a_restricted_intern(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.update(|_, cx| {
            crate::interns::import_test_skill(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../demo/skills/frontend.md")
                    .as_path(),
                cx,
            );
        });
        context.set_state("  ˇ\n");
        assign(&mut context, "frontend-demo");
        for _ in 0..160 {
            tick(&mut context);
        }
        assert!(context.buffer_text().starts_with("  function Greeting"));
        assert!(!context.buffer_text().starts_with("    function"));
        assert!(!context.buffer_text().contains("//"));
    }

    #[gpui::test]
    async fn native_mention_can_be_cancelled_without_changing_code(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("  ˇ\n");
        context.update_editor(|editor, window, cx| {
            editor.handle_input("@", window, cx);
            assert!(editor.pending_inline_input().is_some());
            editor.take_inline_input(window, cx);
        });
        assert_eq!(context.buffer_text(), "  \n");
    }

    #[gpui::test]
    async fn test_typing_keeps_human_cursor_and_undo_preserves_unrelated_edits(
        cx: &mut TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("// @dum-intern: demoˇ\nconst human = 1;\n");
        context.update_editor(|editor, window, cx| editor.run_dum_intern(&Run, window, cx));
        tick(&mut context);
        context.editor(|editor, _, cx| {
            assert_eq!(
                editor
                    .selections
                    .newest::<Point>(&editor.display_snapshot(cx))
                    .head(),
                Point::new(0, 20)
            );
            assert_eq!(
                editor
                    .dum_intern
                    .as_ref()
                    .expect("active dum-intern playback")
                    .next,
                1
            );
        });
        context.update_buffer(|buffer, cx| {
            let offset = buffer.len();
            buffer.edit([(offset..offset, "// human wrote this\n")], None, cx);
        });
        for _ in 0..200 {
            tick(&mut context);
        }
        assert!(context.buffer_text().contains("function greet(name)"));
        context.update_editor(|editor, _, cx| editor.undo_dum_intern(cx));
        assert_eq!(
            context.buffer_text(),
            "// @dum-intern: demo\nconst human = 1;\n// human wrote this\n"
        );
    }

    #[gpui::test]
    async fn test_human_edit_stops_typing_without_overwriting_it(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("// @dum-intern: demoˇ\n");
        context.update_editor(|editor, window, cx| editor.run_dum_intern(&Run, window, cx));
        tick(&mut context);
        context.update_buffer(|buffer, cx| {
            buffer.edit([(3..3, "human ")], None, cx);
        });
        context.run_until_parked();
        let after_edit = context.buffer_text();
        for _ in 0..10 {
            tick(&mut context);
        }
        assert_eq!(context.buffer_text(), after_edit);
        context.editor(|editor, _, _| {
            assert!(
                editor
                    .dum_intern
                    .as_ref()
                    .expect("active dum-intern playback")
                    .state
                    == State::Changed
            )
        });
        context.update_editor(|editor, _, cx| editor.undo_dum_intern(cx));
        assert_eq!(context.buffer_text(), after_edit);
    }

    #[gpui::test]
    async fn test_pause_requires_explicit_resume(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("// @dum-intern: demoˇ\n");
        context.update_editor(|editor, window, cx| editor.run_dum_intern(&Run, window, cx));
        tick(&mut context);
        context.update_editor(|editor, _, cx| editor.pause_dum_intern(cx));
        let paused = context.buffer_text();
        tick(&mut context);
        assert_eq!(context.buffer_text(), paused);
        context.update_editor(|editor, window, cx| editor.resume_dum_intern(window, cx));
        for _ in 0..100 {
            tick(&mut context);
        }
        assert!(context.buffer_text().contains("function greet(name)"));
    }

    #[gpui::test]
    async fn test_regular_undo_stops_playback(cx: &mut TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = EditorTestContext::new(cx).await;
        context.set_state("// @dum-intern: demoˇ\n");
        context.update_editor(|editor, window, cx| editor.run_dum_intern(&Run, window, cx));
        for _ in 0..10 {
            tick(&mut context);
        }
        context.update_editor(|editor, window, cx| editor.undo(&crate::Undo, window, cx));
        context.run_until_parked();
        tick(&mut context);
        assert_eq!(context.buffer_text(), "// @dum-intern: demo\n");
    }
}
