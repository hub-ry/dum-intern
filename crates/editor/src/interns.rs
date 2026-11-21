use anyhow::{Context as _, Result, bail};
use fs::Fs as _;
use gpui::{
    AnyView, App, Context, Entity, EventEmitter, FocusHandle, Focusable, Global, PathPromptOptions,
    Render, SharedString, Task, Window, actions,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, io::Read as _, path::Path, time::Duration};
use ui::{ContextMenu, ContextMenuEntry, DropdownMenu, DropdownStyle, prelude::*};
use ui_input::InputField;
use util::ResultExt;
use workspace::{Item, Workspace};

actions!(dum_intern, [Manage]);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillPolicy {
    #[default]
    Restricted,
    Unrestricted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum SkillSource {
    HumanExample { evidence: String },
    Imported { filename: String, content: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub source: SkillSource,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AvatarShape {
    #[default]
    Round,
    Bloom,
    Square,
    Pebble,
}

impl AvatarShape {
    pub fn path(self) -> &'static str {
        match self {
            Self::Round => "icons/dum_intern.svg",
            Self::Bloom => "icons/dum_intern_bloom.svg",
            Self::Square => "icons/dum_intern_square.svg",
            Self::Pebble => "icons/dum_intern_pebble.svg",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AvatarColor {
    #[default]
    Coral,
    Blue,
    Violet,
    Mint,
    Amber,
    Chalk,
}

impl AvatarColor {
    pub fn value(self) -> gpui::Hsla {
        gpui::rgb(match self {
            Self::Coral => 0xf7768e,
            Self::Blue => 0x388bff,
            Self::Violet => 0x9965ff,
            Self::Mint => 0x35cc99,
            Self::Amber => 0xffb020,
            Self::Chalk => 0xefefea,
        })
        .into()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InternAppearance {
    pub shape: AvatarShape,
    pub color: AvatarColor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intern {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub appearance: InternAppearance,
    #[serde(default)]
    pub policy: SkillPolicy,
    #[serde(default)]
    #[serde(alias = "instructions")]
    pub description: String,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    #[serde(default)]
    pub skills: Vec<Skill>,
}

impl Intern {
    fn new(name: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            appearance: InternAppearance::default(),
            policy: SkillPolicy::Restricted,
            description: String::new(),
            provider: "OpenAI".into(),
            model: String::new(),
            endpoint: String::new(),
            skills: Vec::new(),
        }
    }

    pub fn missing_skills<'a>(&self, required: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        if self.policy == SkillPolicy::Unrestricted {
            return Vec::new();
        }
        required
            .into_iter()
            .filter(|name| !self.skills.iter().any(|skill| skill.name == *name))
            .map(str::to_owned)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub fn learn_human_example(&mut self, name: String, evidence: String) -> Result<()> {
        if name.trim().is_empty() || evidence.trim().is_empty() {
            bail!("A learned skill needs a name and human-authored evidence.");
        }
        self.skills.push(Skill {
            name,
            source: SkillSource::HumanExample { evidence },
        });
        Ok(())
    }

    pub fn import_skill(&mut self, path: &Path) -> Result<()> {
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            bail!("Choose a Markdown (.md) skill file.");
        }
        if std::fs::metadata(path)?.len() > 256 * 1024 {
            bail!("Skill files must be smaller than 256 KB.");
        }
        let content =
            std::fs::read_to_string(path).context("Could not read skill file as UTF-8")?;
        if content.trim().is_empty() {
            bail!("The skill file is empty.");
        }
        let filename = path
            .file_name()
            .context("Missing skill filename")?
            .to_string_lossy()
            .into_owned();
        let name = path
            .file_stem()
            .context("Missing skill name")?
            .to_string_lossy()
            .into_owned();
        self.skills.retain(|skill| !matches!(&skill.source, SkillSource::Imported { filename: existing, .. } if *existing == filename));
        self.skills.push(Skill {
            name,
            source: SkillSource::Imported { filename, content },
        });
        Ok(())
    }

    pub fn credential_service(&self) -> String {
        let endpoint = if self.provider == "DeepSeek" && self.endpoint.is_empty() {
            "https://api.deepseek.com"
        } else {
            self.endpoint.as_str()
        };
        format!(
            "dum/interns/{}/{}/{}",
            self.id,
            self.provider,
            endpoint.trim_end_matches('/')
        )
    }
}

const INTERN_PACKAGE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InternPackage {
    format: String,
    version: u32,
    name: String,
    appearance: InternAppearance,
    #[serde(alias = "instructions")]
    description: String,
    policy: SkillPolicy,
    skills: Vec<Skill>,
}

impl InternPackage {
    fn encode(intern: &Intern, include_learned: bool) -> Result<String> {
        let package = Self {
            format: "dum.intern".into(),
            version: 1,
            name: intern.name.clone(),
            appearance: intern.appearance,
            description: intern.description.clone(),
            policy: intern.policy,
            skills: intern
                .skills
                .iter()
                .filter(|skill| {
                    include_learned || matches!(skill.source, SkillSource::Imported { .. })
                })
                .cloned()
                .collect(),
        };
        package.validate()?;
        let json = serde_json::to_string_pretty(&package)?;
        if json.len() > INTERN_PACKAGE_LIMIT {
            bail!("Intern files must be smaller than 8 MB.");
        }
        Ok(json)
    }

    fn validate(&self) -> Result<()> {
        if self.format != "dum.intern" || self.version != 1 {
            bail!("Unsupported intern file format or version.");
        }
        let mut intern = Intern::new(self.name.clone());
        intern.description = self.description.clone();
        InternConfig {
            version: 1,
            interns: vec![intern],
        }
        .validate()?;
        if self.description.len() > 64 * 1024 || self.skills.len() > 256 {
            bail!("Intern files support up to 64 KB of description and 256 skills.");
        }
        let mut names = BTreeSet::new();
        for skill in &self.skills {
            let content = match &skill.source {
                SkillSource::Imported { content, .. } => content,
                SkillSource::HumanExample { evidence } => evidence,
            };
            if skill.name.trim().is_empty()
                || !names.insert(&skill.name)
                || content.trim().is_empty()
                || content.len() > 256 * 1024
            {
                bail!("Each skill needs a unique name and nonempty content smaller than 256 KB.");
            }
        }
        Ok(())
    }

    fn decode(bytes: &[u8]) -> Result<Intern> {
        if bytes.len() > INTERN_PACKAGE_LIMIT {
            bail!("Intern files must be smaller than 8 MB.");
        }
        let package: Self = serde_json::from_slice(bytes).context("Could not read intern file")?;
        package.validate()?;
        let mut intern = Intern::new(package.name);
        intern.provider.clear();
        intern.appearance = package.appearance;
        intern.description = package.description;
        intern.policy = package.policy;
        intern.skills = package.skills;
        Ok(intern)
    }

    fn read(path: &Path) -> Result<Intern> {
        if path.extension().and_then(|extension| extension.to_str()) != Some("intern") {
            bail!("Choose a Dum (.intern) file.");
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take((INTERN_PACKAGE_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        Self::decode(&bytes)
    }
}

fn unique_intern_name(name: &str, existing: &BTreeSet<String>) -> String {
    if !existing.contains(name) {
        return name.to_owned();
    }
    let mut number = 2;
    while existing.contains(&format!("{name}-{number}")) {
        number += 1;
    }
    format!("{name}-{number}")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InternConfig {
    pub version: u32,
    pub interns: Vec<Intern>,
}

impl Default for InternConfig {
    fn default() -> Self {
        let mut intern = Intern::new("dum-intern".into());
        intern.id = "dum-intern".into();
        Self {
            version: 1,
            interns: vec![intern],
        }
    }
}

impl InternConfig {
    fn validate(&self) -> Result<()> {
        if self.version != 1 {
            bail!("Unsupported intern configuration version.");
        }
        if self.interns.is_empty() {
            bail!("Keep at least one intern.");
        }
        let mut names = BTreeSet::new();
        let mut identifiers = BTreeSet::new();
        for intern in &self.interns {
            if intern.id.is_empty() || !identifiers.insert(&intern.id) {
                bail!("Each intern needs a unique identifier.");
            }
            if intern.name.is_empty()
                || !intern.name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-' || character == '_'
                })
            {
                bail!("Intern names can contain letters, numbers, hyphens and underscores.");
            }
            if !names.insert(&intern.name) {
                bail!("Each intern needs a unique name.");
            }
        }
        Ok(())
    }
}

struct Registry {
    config: InternConfig,
    revision: u64,
    saving: bool,
    load_error: Option<String>,
}
impl Global for Registry {}

pub fn profile(name: &str, cx: &App) -> Option<Intern> {
    cx.try_global::<Registry>()?
        .config
        .interns
        .iter()
        .find(|intern| intern.name == name)
        .cloned()
}

pub fn mention_profiles(cx: &App) -> Vec<(String, InternAppearance)> {
    cx.try_global::<Registry>()
        .map(|registry| {
            registry
                .config
                .interns
                .iter()
                .map(|intern| (intern.name.clone(), intern.appearance))
                .collect()
        })
        .unwrap_or_else(|| vec![("dum-intern".into(), InternAppearance::default())])
}

pub fn init(cx: &mut App) {
    if !cx.has_global::<Registry>() {
        let path = paths::data_dir().join("interns.json");
        let loaded = if cx.is_test() {
            Ok(InternConfig::default())
        } else {
            match std::fs::read(&path) {
                Ok(bytes) => serde_json::from_slice::<InternConfig>(&bytes)
                    .map_err(anyhow::Error::from)
                    .and_then(|config| {
                        config.validate()?;
                        Ok(config)
                    }),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(InternConfig::default())
                }
                Err(error) => Err(error.into()),
            }
        };
        let (config, load_error) = match loaded {
            Ok(config) => (config, None),
            Err(error) => (
                InternConfig::default(),
                Some(format!(
                    "Could not load {}: {error}. Fix the file before saving.",
                    path.display()
                )),
            ),
        };
        cx.set_global(Registry {
            config,
            revision: 0,
            saving: false,
            load_error,
        });
    }
    cx.observe_new(
        |workspace: &mut Workspace, window: Option<&mut Window>, cx: &mut Context<Workspace>| {
            workspace.register_action(|workspace, _: &Manage, window, cx| {
                if let Some(page) = workspace.item_of_type::<InternsPage>(cx) {
                    workspace.activate_item(&page, true, true, window, cx);
                } else {
                    let page = cx.new(|cx| InternsPage::new(window, cx));
                    workspace.add_item_to_active_pane(Box::new(page), None, true, window, cx);
                }
            });
            if let Some(window) = window {
                let button = cx.new(|_| InternsButton);
                workspace
                    .status_bar()
                    .update(cx, |status, cx| status.add_right_item(button, window, cx));
            }
        },
    )
    .detach();
}

fn provider_defaults(provider: &str) -> (&'static str, &'static str) {
    match provider {
        "DeepSeek" => ("deepseek-flash", "https://api.deepseek.com"),
        _ => ("", ""),
    }
}

fn subscription_settings(provider: &str, window: &mut Window, cx: &mut App) -> Option<AnyView> {
    let provider = crate::intern_model::subscription_provider(provider, cx)?;
    let language_model::ProviderSettingsView::Inline(settings) = provider.settings_view(cx)? else {
        return None;
    };
    Some((settings.create_view)(window, cx))
}

#[derive(Clone)]
enum InternSetting {
    Policy(SkillPolicy),
    Provider(String),
    Model(String),
    Appearance(InternAppearance),
}

impl InternSetting {
    fn apply(&self, intern: &mut Intern) {
        match self {
            Self::Policy(policy) => intern.policy = *policy,
            Self::Provider(provider) => {
                intern.provider = provider.clone();
                let (model, endpoint) = provider_defaults(provider);
                intern.model = model.to_owned();
                intern.endpoint = endpoint.to_owned();
            }
            Self::Model(model) => intern.model = model.clone(),
            Self::Appearance(appearance) => intern.appearance = *appearance,
        }
    }

    fn apply_form(&self, form: &mut InternForm, window: &mut Window, cx: &mut App) {
        self.apply(&mut form.intern);
        match self {
            Self::Policy(_) | Self::Appearance(_) => {}
            Self::Provider(provider) => {
                form.account = subscription_settings(provider, window, cx);
                form.model.update(cx, |field, cx| {
                    field.set_text(&form.intern.model, window, cx)
                });
                form.endpoint.update(cx, |field, cx| {
                    field.set_text(&form.intern.endpoint, window, cx)
                });
                form.key.update(cx, |key, cx| key.clear(window, cx));
            }
            Self::Model(model) => form
                .model
                .update(cx, |field, cx| field.set_text(model, window, cx)),
        }
    }
}

struct InternForm {
    intern: Intern,
    name: Entity<InputField>,
    description: Entity<InputField>,
    model: Entity<InputField>,
    endpoint: Entity<InputField>,
    key: Entity<InputField>,
    account: Option<AnyView>,
    skills_expanded: bool,
    connection_expanded: bool,
    _field_subscriptions: Vec<gpui::Subscription>,
}

impl InternForm {
    fn new(intern: Intern, window: &mut Window, cx: &mut App) -> Self {
        let field = |value: &str, placeholder: &str, window: &mut Window, cx: &mut App| {
            cx.new(|cx| {
                let field = InputField::new(window, cx, placeholder);
                field.set_text(value, window, cx);
                field
            })
        };
        Self {
            account: subscription_settings(&intern.provider, window, cx),
            name: field(&intern.name, "Intern name", window, cx),
            description: cx.new(|cx| {
                let field = InputField::new(
                    window,
                    cx,
                    "Describe this intern's role and how it should work…",
                );
                field.editor().set_multiline(Some(12), window, cx);
                field.set_text(&intern.description, window, cx);
                field
            }),
            model: field(&intern.model, "Model identifier", window, cx),
            endpoint: field(&intern.endpoint, "Default provider endpoint", window, cx),
            key: cx.new(|cx| {
                InputField::new(window, cx, "Leave blank to keep the saved key").masked(true)
            }),
            intern,
            skills_expanded: true,
            connection_expanded: false,
            _field_subscriptions: Vec::new(),
        }
    }

    fn snapshot(&self, cx: &App) -> Intern {
        let mut intern = self.intern.clone();
        intern.name = self.name.read(cx).text(cx).trim().to_owned();
        intern.description = self.description.read(cx).text(cx);
        intern.model = self.model.read(cx).text(cx).trim().to_owned();
        intern.endpoint = self.endpoint.read(cx).text(cx).trim().to_owned();
        intern
    }
}

fn persist_config(bytes: Vec<u8>, cx: &gpui::AsyncApp) -> Task<Result<()>> {
    if cx.is_test() {
        return Task::ready(Ok(()));
    }
    cx.background_spawn(async move {
        let path = paths::data_dir().join("interns.json");
        std::fs::create_dir_all(paths::data_dir())?;
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })
}

pub struct InternsPage {
    focus: FocusHandle,
    forms: Vec<InternForm>,
    selected: usize,
    revision: u64,
    saved: InternConfig,
    message: SharedString,
    saving: bool,
    _provider_subscription: Option<gpui::Subscription>,
    autosave_task: Option<Task<()>>,
    autosave_running: bool,
    edit_generation: u64,
}

impl InternsPage {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let registry = cx.global::<Registry>();
        let config = registry.config.clone();
        let revision = registry.revision;
        let message = registry.load_error.clone().unwrap_or_default().into();
        let provider_subscription = language_model::LanguageModelRegistry::try_global(cx)
            .map(|registry| cx.subscribe(&registry, |_, _, _, cx| cx.notify()));
        let mut page = Self {
            _provider_subscription: provider_subscription,
            focus: cx.focus_handle(),
            selected: 0,
            saved: config.clone(),
            forms: config
                .interns
                .into_iter()
                .map(|intern| InternForm::new(intern, window, cx))
                .collect(),
            revision,
            message,
            saving: false,
            autosave_task: None,
            autosave_running: false,
            edit_generation: 0,
        };
        for index in 0..page.forms.len() {
            page.watch_fields(index, window, cx);
        }
        page
    }

    fn watch_fields(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = self.forms.get_mut(index) else {
            return;
        };
        for field in [
            &form.name,
            &form.description,
            &form.model,
            &form.endpoint,
            &form.key,
        ] {
            let editor = field.read(cx).editor().clone();
            let page = cx.weak_entity();
            form._field_subscriptions.push(editor.subscribe(
                Box::new(move |event, window, cx| {
                    if matches!(
                        event,
                        ui_input::ErasedEditorEvent::BufferEdited
                            | ui_input::ErasedEditorEvent::Blurred
                    ) {
                        page.update(cx, |page, cx| page.queue_autosave(window, cx))
                            .log_err();
                    }
                }),
                window,
                cx,
            ));
        }
    }

    fn queue_autosave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_generation += 1;
        cx.notify();
        if self.autosave_running {
            return;
        }
        self.autosave_running = true;
        self.autosave_task = Some(cx.spawn_in(window, async move |page, cx| {
            loop {
                let Ok(generation) = page.read_with(cx, |page, _| page.edit_generation) else {
                    return;
                };
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                let next = page.update_in(cx, |page, window, cx| {
                    if page.edit_generation != generation
                        || page.saving
                        || cx.global::<Registry>().saving
                    {
                        return Some(None);
                    }
                    let editing_key = page.forms.iter().any(|form| {
                        !form.key.read(cx).text(cx).is_empty()
                            && form.key.focus_handle(cx).is_focused(window)
                    });
                    if !page.is_dirty(cx) || editing_key {
                        page.autosave_running = false;
                        cx.notify();
                        return None;
                    }
                    let save = page.begin_save(window, cx);
                    let (completed, completion) = futures::channel::oneshot::channel();
                    // Finish disk writes even if the settings tab closes.
                    cx.spawn(async move |_, _| {
                        if completed.send(save.await.is_ok()).is_err() {
                            log::debug!("Intern settings saved after the page closed");
                        }
                    })
                    .detach();
                    Some(Some(completion))
                });
                match next {
                    Ok(Some(Some(save))) => {
                        if !matches!(save.await, Ok(true)) {
                            page.update(cx, |page, cx| {
                                page.autosave_running = false;
                                cx.notify();
                            })
                            .log_err();
                            return;
                        }
                    }
                    Ok(Some(None)) => {}
                    _ => return,
                }
            }
        }));
    }

    fn add_intern(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut number = self.forms.len() + 1;
        while self
            .forms
            .iter()
            .any(|form| form.name.read(cx).text(cx) == format!("intern-{number}"))
        {
            number += 1;
        }
        let mut intern = Intern::new(format!("intern-{number}"));
        intern.provider = self
            .forms
            .get(self.selected)
            .map(|form| form.intern.provider.clone())
            .unwrap_or_else(|| "ChatGPT Subscription".into());
        let (model, endpoint) = provider_defaults(&intern.provider);
        intern.model = model.into();
        intern.endpoint = endpoint.into();
        intern.appearance.color = [
            AvatarColor::Coral,
            AvatarColor::Blue,
            AvatarColor::Violet,
            AvatarColor::Mint,
            AvatarColor::Amber,
            AvatarColor::Chalk,
        ][self.forms.len() % 6];
        self.forms.push(InternForm::new(intern, window, cx));
        self.selected = self.forms.len() - 1;
        self.watch_fields(self.selected, window, cx);
        self.queue_autosave(window, cx);
        cx.notify();
    }

    fn change_setting(
        &mut self,
        index: usize,
        setting: InternSetting,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<()>> {
        let Some(form) = self.forms.get(index) else {
            return Task::ready(Ok(()));
        };
        let id = form.intern.id.clone();
        let registry = cx.global::<Registry>();
        if self.saving
            || registry.saving
            || registry.revision != self.revision
            || registry.load_error.is_some()
        {
            self.message = "Could not change this setting. Wait for the current save, or reopen Interns to reload its settings.".into();
            cx.notify();
            return Task::ready(Err(anyhow::anyhow!(self.message.to_string())));
        }
        let mut config = registry.config.clone();
        let Some(intern) = config.interns.iter_mut().find(|intern| intern.id == id) else {
            if let Some(form) = self.forms.get_mut(index) {
                setting.apply_form(form, window, cx);
            }
            self.queue_autosave(window, cx);
            cx.notify();
            return Task::ready(Ok(()));
        };
        setting.apply(intern);
        let bytes = match serde_json::to_vec_pretty(&config) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.message = error.to_string().into();
                cx.notify();
                return Task::ready(Err(error.into()));
            }
        };
        self.saving = true;
        cx.global_mut::<Registry>().saving = true;
        self.message = "Saving setting...".into();
        cx.notify();
        cx.spawn_in(window, async move |page, cx| {
            let result = persist_config(bytes, cx).await;
            let revision = gpui::AsyncApp::update_global::<Registry, _>(cx, |registry, _| {
                registry.saving = false;
                if result.is_ok() {
                    registry.config = config;
                    registry.revision += 1;
                }
                registry.revision
            });
            page.update_in(cx, |page, window, cx| {
                page.saving = false;
                match &result {
                    Ok(()) => {
                        page.revision = revision;
                        if let Some(form) = page.forms.iter_mut().find(|form| form.intern.id == id)
                        {
                            setting.apply_form(form, window, cx);
                        }
                        if let Some(intern) =
                            page.saved.interns.iter_mut().find(|intern| intern.id == id)
                        {
                            setting.apply(intern);
                        }
                        page.message = "Saved".into();
                    }
                    Err(error) => {
                        page.message = format!("Could not save setting: {error:#}").into()
                    }
                }
                cx.notify();
            })
            .log_err();
            result
        })
    }

    fn begin_save(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Task<Result<()>> {
        if self.saving {
            self.message = "A save is already in progress.".into();
            return Task::ready(Err(anyhow::anyhow!(self.message.to_string())));
        }
        let registry = cx.global::<Registry>();
        if let Some(error) = &registry.load_error {
            self.message = error.clone().into();
            cx.notify();
            return Task::ready(Err(anyhow::anyhow!(self.message.to_string())));
        }
        if registry.saving {
            self.message = "Another window is saving interns. Try again in a moment.".into();
            cx.notify();
            return Task::ready(Err(anyhow::anyhow!(self.message.to_string())));
        }
        if registry.revision != self.revision {
            self.message =
                "Interns changed in another window. Reopen this tab before saving.".into();
            cx.notify();
            return Task::ready(Err(anyhow::anyhow!(self.message.to_string())));
        }
        let config = InternConfig {
            version: 1,
            interns: self.forms.iter().map(|form| form.snapshot(cx)).collect(),
        };
        if let Err(error) = config.validate() {
            self.message = error.to_string().into();
            cx.notify();
            return Task::ready(Err(anyhow::anyhow!(self.message.to_string())));
        }
        let keys: Vec<_> = self
            .forms
            .iter()
            .filter(|form| {
                crate::intern_model::subscription_provider_id(&form.intern.provider).is_none()
            })
            .map(|form| {
                (
                    form.snapshot(cx).credential_service(),
                    form.key.read(cx).text(cx),
                )
            })
            .filter(|(_, key)| !key.is_empty())
            .collect();
        let writes: Vec<_> = keys
            .iter()
            .map(|(service, key)| cx.write_credentials(service, "api-key", key.as_bytes()))
            .collect();
        let bytes = match serde_json::to_vec_pretty(&config) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.message = error.to_string().into();
                return Task::ready(Err(anyhow::anyhow!(self.message.to_string())));
            }
        };
        self.saving = true;
        cx.global_mut::<Registry>().saving = true;
        self.message = "Saving...".into();
        cx.notify();
        cx.spawn_in(window, async move |page, cx| {
            let result: Result<()> = async {
                for write in writes {
                    write
                        .await
                        .context("Could not save API key in the system keychain")?;
                }
                persist_config(bytes, cx).await
            }
            .await;
            let revision = gpui::AsyncApp::update_global::<Registry, _>(cx, |registry, _| {
                registry.saving = false;
                if result.is_ok() {
                    registry.config = config.clone();
                    registry.revision += 1;
                }
                registry.revision
            });
            page.update_in(cx, |page, window, cx| {
                page.saving = false;
                match &result {
                    Ok(()) => {
                        page.revision = revision;
                        page.saved = config;
                        for form in &mut page.forms {
                            if keys.iter().any(|(service, key)| {
                                *service == form.snapshot(cx).credential_service()
                                    && *key == form.key.read(cx).text(cx)
                            }) {
                                form.key.update(cx, |key, cx| key.clear(window, cx));
                            }
                            if let Some(saved) = cx
                                .global::<Registry>()
                                .config
                                .interns
                                .iter()
                                .find(|intern| intern.id == form.intern.id)
                            {
                                form.intern.name = saved.name.clone();
                                form.intern.description = saved.description.clone();
                                form.intern.model = saved.model.clone();
                                form.intern.endpoint = saved.endpoint.clone();
                            }
                        }
                        page.message = "Saved".into();
                    }
                    Err(error) => page.message = format!("Could not save: {error:#}").into(),
                }
                cx.notify();
            })
            .log_err();
            result
        })
    }

    fn import_intern(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let selection = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Import intern".into()),
        });
        cx.spawn_in(window, async move |page, cx| {
            let result: Result<Option<Intern>> = async {
                let Some(paths) = selection.await?? else {
                    return Ok(None);
                };
                let path = paths
                    .into_iter()
                    .next()
                    .context("No intern file selected")?;
                cx.background_spawn(async move { InternPackage::read(&path).map(Some) })
                    .await
            }
            .await;
            page.update_in(cx, |page, window, cx| {
                match result {
                    Ok(Some(mut intern)) => {
                        let names = page
                            .forms
                            .iter()
                            .map(|form| form.snapshot(cx).name)
                            .collect();
                        intern.name = unique_intern_name(&intern.name, &names);
                        page.forms.push(InternForm::new(intern, window, cx));
                        page.selected = page.forms.len() - 1;
                        page.watch_fields(page.selected, window, cx);
                        if let Some(form) = page.forms.get_mut(page.selected) {
                            form.connection_expanded = true;
                        }
                        page.queue_autosave(window, cx);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        page.message = format!("Could not import intern: {error:#}").into()
                    }
                }
                cx.notify();
            })
            .log_err();
        })
        .detach();
    }

    fn export_intern(
        &mut self,
        index: usize,
        include_learned: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(form) = self.forms.get(index) else {
            return;
        };
        let intern = form.snapshot(cx);
        let confirmation = include_learned.then(|| window.prompt(
            gpui::PromptLevel::Warning,
            "Include learned skills?",
            Some("Learned examples may contain private project code. Only share this file with people who should see those examples. API keys and account credentials are never exported."),
            &["Include learned skills", "Cancel"], cx,
        ));
        let fs = fs::RealFs::new(None, cx.background_executor().clone());
        cx.spawn_in(window, async move |page, cx| {
            let result: Result<bool> = async {
                if let Some(confirmation) = confirmation {
                    if confirmation.await? != 0 { return Ok(false); }
                }
                let filename = format!("{}.intern", intern.name);
                let json = cx.background_spawn(async move { InternPackage::encode(&intern, include_learned) }).await?;
                let selection = cx.update(|_, cx| cx.prompt_for_new_path(&std::env::home_dir().unwrap_or_default(), Some(&filename)))?;
                let Some(mut path) = selection.await?? else { return Ok(false); };
                if path.extension().and_then(|extension| extension.to_str()) != Some("intern") {
                    path.set_extension("intern");
                    if path.exists() { bail!("That .intern file already exists. Choose its full filename in the save dialog to replace it."); }
                }
                fs.atomic_write(path, json).await?;
                Ok(true)
            }.await;
            page.update(cx, |page, cx| {
                match result {
                    Ok(true) => page.message = "Intern exported. Connections and credentials stay on this machine.".into(),
                    Ok(false) => {}
                    Err(error) => page.message = format!("Could not export intern: {error:#}").into(),
                }
                cx.notify();
            }).log_err();
        }).detach();
    }

    fn import(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = self.forms.get(index) else {
            return;
        };
        let identifier = form.intern.id.clone();
        let selection = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Import skill files".into()),
        });
        cx.spawn_in(window, async move |page, cx| {
            let result: Result<Option<Vec<Skill>>> = async {
                let Some(paths) = selection.await?? else {
                    return Ok(None);
                };
                cx.background_spawn(async move {
                    let mut intern = Intern::new("import".into());
                    for path in paths {
                        intern.import_skill(&path)?;
                    }
                    Ok(Some(intern.skills))
                })
                .await
            }
            .await;
            page.update_in(cx, |page, window, cx| {
                match result {
                    Ok(Some(skills)) => {
                        if let Some(form) = page
                            .forms
                            .iter_mut()
                            .find(|form| form.intern.id == identifier)
                        {
                            for skill in skills {
                                form.intern
                                    .skills
                                    .retain(|existing| existing.name != skill.name);
                                form.intern.skills.push(skill);
                            }
                            form.skills_expanded = true;
                            page.queue_autosave(window, cx);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => page.message = format!("Could not import: {error:#}").into(),
                }
                cx.notify();
            })
            .log_err();
        })
        .detach();
    }
}

impl EventEmitter<()> for InternsPage {}
impl Focusable for InternsPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl Item for InternsPage {
    type Event = ();
    fn tab_content_text(&self, _: usize, _: &App) -> SharedString {
        "Interns".into()
    }
    fn to_item_events(_: &(), _: &mut dyn FnMut(workspace::item::ItemEvent)) {}
    fn telemetry_event_text(&self) -> Option<&'static str> {
        None
    }
    fn is_dirty(&self, cx: &App) -> bool {
        self.forms
            .iter()
            .any(|form| !form.key.read(cx).text(cx).is_empty())
            || self
                .forms
                .iter()
                .map(|form| form.snapshot(cx))
                .collect::<Vec<_>>()
                != self.saved.interns
    }
    fn can_save(&self, _: &App) -> bool {
        true
    }
    fn save(
        &mut self,
        _: workspace::item::SaveOptions,
        _: Entity<project::Project>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<()>> {
        self.begin_save(window, cx)
    }
    fn show_toolbar(&self) -> bool {
        false
    }
}

struct CharacterPicker {
    page: gpui::WeakEntity<InternsPage>,
    intern_id: String,
    focus: FocusHandle,
    _subscription: gpui::Subscription,
}

impl Focusable for CharacterPicker {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl EventEmitter<gpui::DismissEvent> for CharacterPicker {}

impl CharacterPicker {
    fn choose(
        &self,
        shape: Option<AvatarShape>,
        color: Option<AvatarColor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.page
            .update(cx, |page, cx| {
                let Some(index) = page
                    .forms
                    .iter()
                    .position(|form| form.intern.id == self.intern_id)
                else {
                    return;
                };
                let mut appearance = page.forms[index].intern.appearance;
                if let Some(shape) = shape {
                    appearance.shape = shape;
                }
                if let Some(color) = color {
                    appearance.color = color;
                }
                page.change_setting(index, InternSetting::Appearance(appearance), window, cx)
                    .detach_and_log_err(cx);
            })
            .log_err();
    }
}

impl Render for CharacterPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let appearance = self
            .page
            .read_with(cx, |page, _| {
                page.forms
                    .iter()
                    .find(|form| form.intern.id == self.intern_id)
                    .map(|form| form.intern.appearance)
            })
            .ok()
            .flatten()
            .unwrap_or_default();
        v_flex()
            .key_context("menu")
            .track_focus(&self.focus)
            .p_3()
            .gap_3()
            .elevation_3(cx)
            .occlude()
            .on_action(cx.listener(|_, _: &menu::Cancel, _, cx| cx.emit(gpui::DismissEvent)))
            .child(
                Label::new("Shape")
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
            .child(
                h_flex().gap_1().children(
                    [
                        (AvatarShape::Round, "Round"),
                        (AvatarShape::Bloom, "Bloom"),
                        (AvatarShape::Square, "Soft square"),
                        (AvatarShape::Pebble, "Pebble"),
                    ]
                    .into_iter()
                    .enumerate()
                    .map(|(index, (shape, label))| {
                        ui::ButtonLike::new(("choose-shape", index))
                            .width(px(42.))
                            .height(px(42.).into())
                            .style(ButtonStyle::Subtle)
                            .toggle_state(appearance.shape == shape)
                            .aria_label(label)
                            .tooltip(ui::Tooltip::text(label))
                            .child(
                                Icon::from_path(shape.path())
                                    .size(IconSize::Custom(rems(2.)))
                                    .color(Color::Custom(appearance.color.value())),
                            )
                            .on_click(cx.listener(move |picker, _, window, cx| {
                                picker.choose(Some(shape), None, window, cx)
                            }))
                    }),
                ),
            )
            .child(
                Label::new("Color")
                    .size(LabelSize::Small)
                    .color(Color::Muted),
            )
            .child(
                h_flex().gap_1().children(
                    [
                        (AvatarColor::Coral, "Coral"),
                        (AvatarColor::Blue, "Blue"),
                        (AvatarColor::Violet, "Violet"),
                        (AvatarColor::Mint, "Mint"),
                        (AvatarColor::Amber, "Amber"),
                        (AvatarColor::Chalk, "Chalk"),
                    ]
                    .into_iter()
                    .enumerate()
                    .map(|(index, (color, label))| {
                        ui::ButtonLike::new(("choose-color", index))
                            .width(px(26.))
                            .height(px(26.).into())
                            .style(ButtonStyle::Subtle)
                            .toggle_state(appearance.color == color)
                            .aria_label(label)
                            .tooltip(ui::Tooltip::text(label))
                            .child(div().size(px(18.)).rounded_full().bg(color.value()))
                            .on_click(cx.listener(move |picker, _, window, cx| {
                                picker.choose(None, Some(color), window, cx)
                            }))
                    }),
                ),
            )
    }
}

impl Render for InternsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let roster = self
            .forms
            .iter()
            .enumerate()
            .map(|(index, form)| {
                let selected = self.selected == index;
                h_flex()
                    .id(("intern-roster-entry", index))
                    .w_full()
                    .min_w_0()
                    .gap_2()
                    .p_2()
                    .rounded_md()
                    .cursor_pointer()
                    .when(selected, |row| row.bg(cx.theme().colors().element_selected))
                    .hover(|row| row.bg(cx.theme().colors().element_hover))
                    .child(
                        Icon::from_path(form.intern.appearance.shape.path())
                            .size(IconSize::XLarge)
                            .color(Color::Custom(form.intern.appearance.color.value())),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(Label::new(form.name.read(cx).text(cx)).truncate())
                            .child(
                                Label::new(if form.intern.provider.is_empty() {
                                    "Not connected".to_owned()
                                } else {
                                    form.intern.provider.clone()
                                })
                                .truncate()
                                .size(LabelSize::XSmall)
                                .color(Color::Muted),
                            ),
                    )
                    .on_click(cx.listener(move |page, _, _, cx| {
                        page.selected = index;
                        cx.notify();
                    }))
            })
            .collect::<Vec<_>>();
        let mut cards = Vec::new();
        for (index, form) in self.forms.iter().enumerate() {
            if index != self.selected {
                continue;
            }
            let page = cx.weak_entity();
            let provider_menu = ContextMenu::build(window, cx, move |mut menu, _, _| {
                for provider in [
                    "ChatGPT Subscription",
                    "SuperGrok",
                    "DeepSeek",
                    "OpenAI",
                    "Anthropic",
                    "OpenAI-compatible",
                    "Ollama",
                ] {
                    let page = page.clone();
                    menu.push_item(ContextMenuEntry::new(provider).handler(move |window, cx| {
                        if let Some(task) = page
                            .update(cx, |page, cx| {
                                page.change_setting(
                                    index,
                                    InternSetting::Provider(provider.into()),
                                    window,
                                    cx,
                                )
                            })
                            .log_err()
                        {
                            task.detach_and_log_err(cx);
                        }
                    }));
                }
                menu
            });
            let mut card = v_flex()
                .w_full()
                .max_w(px(680.))
                .gap_3()
                .child(
                    h_flex()
                        .gap_3()
                        .mb_2()
                        .child(
                            ui::PopoverMenu::new(("character-picker", index))
                                .trigger_with_tooltip(
                                    ui::ButtonLike::new(("edit-character", index))
                                        .style(ButtonStyle::Subtle)
                                        .width(px(56.))
                                        .height(px(56.).into())
                                        .aria_label("Customize character")
                                        .child(
                                            Icon::from_path(form.intern.appearance.shape.path())
                                                .size(IconSize::XLarge)
                                                .color(Color::Custom(
                                                    form.intern.appearance.color.value(),
                                                )),
                                        ),
                                    ui::Tooltip::text("Customize character"),
                                )
                                .menu({
                                    let page = cx.entity();
                                    let id = form.intern.id.clone();
                                    move |_, cx| {
                                        Some(cx.new(|cx| {
                                            let subscription =
                                                cx.observe(&page, |_, _, cx| cx.notify());
                                            CharacterPicker {
                                                page: page.downgrade(),
                                                intern_id: id.clone(),
                                                focus: cx.focus_handle(),
                                                _subscription: subscription,
                                            }
                                        }))
                                    }
                                }),
                        )
                        .child(
                            v_flex()
                                .gap_1()
                                .child(Headline::new(form.name.read(cx).text(cx)))
                                .child(
                                    Label::new(format!("@{}", form.intern.name))
                                        .size(LabelSize::Small)
                                        .color(Color::Muted),
                                ),
                        ),
                )
                .child(
                    Label::new("Name")
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                );
            {
                card = card
                    .child(form.name.clone())
                    .child(Label::new("Description").size(LabelSize::Small).color(Color::Muted))
                    .child(div().key_context("InternDescription").child(form.description.clone()))
                    .child(Label::new("Sets the intern’s role and working style. Cmd+Return adds a line.").size(LabelSize::Small).color(Color::Muted))
                    .child(div().mt_3().child(Label::new("Work style")))
                    .child(
                        h_flex()
                            .gap_2().flex_wrap()
                            .child(
                                Button::new(("restricted", index), "Skills only")
                                    .toggle_state(form.intern.policy == SkillPolicy::Restricted)
                                    .disabled(self.saving)
                                    .on_click(cx.listener(move |page, _, window, cx| {
                                        page.change_setting(index, InternSetting::Policy(SkillPolicy::Restricted), window, cx)
                                            .detach_and_log_err(cx);
                                    })),
                            )
                            .child(
                                Button::new(("unrestricted", index), "Allow new work")
                                    .toggle_state(form.intern.policy == SkillPolicy::Unrestricted)
                                    .disabled(self.saving)
                                    .on_click(cx.listener(move |page, _, window, cx| {
                                        page.change_setting(index, InternSetting::Policy(SkillPolicy::Unrestricted), window, cx)
                                            .detach_and_log_err(cx);
                                    })),
                            ),
                    )
                    .child(
                        Label::new(if form.intern.policy == SkillPolicy::Restricted {
                            "Missing a skill? Leave a TODO for you."
                        } else {
                            "May attempt tasks beyond learned and imported skills."
                        })
                        .size(LabelSize::Small)
                        .color(Color::Muted),
                    )
                    .child(h_flex().mt_3().gap_2().flex_wrap()
                        .child(Button::new(("connection-expand", index), "Connection")
                            .start_icon(Icon::new(if form.connection_expanded { IconName::ChevronDown } else { IconName::ChevronRight }))
                            .on_click(cx.listener(move |page, _, _, cx| {
                                if let Some(form) = page.forms.get_mut(index) { form.connection_expanded = !form.connection_expanded; }
                                cx.notify();
                            })))
                        .child(Label::new(if form.intern.provider.is_empty() { "Not connected".to_owned() } else { format!("{} · {}", form.intern.provider,
                            if form.intern.model.is_empty() { "Account default" } else { &form.intern.model }) })
                            .size(LabelSize::Small).color(Color::Muted).truncate()))
                    .when(form.connection_expanded, |card| card

                    .child(Label::new("Provider").size(LabelSize::Small).color(Color::Muted))
                    .child(
                        DropdownMenu::new(
                            ("provider", index),
                            if form.intern.provider.is_empty() { "Choose provider".into() } else { form.intern.provider.clone() },
                            provider_menu,
                        )
                        .style(DropdownStyle::Outlined)
                        .full_width(true),
                    )
                    .when(
                        crate::intern_model::subscription_provider_id(&form.intern.provider).is_none(),
                        |card| card
                            .child(Label::new("Model"))
                            .child(form.model.clone())
                            .child(Label::new("API endpoint"))
                            .child(form.endpoint.clone())
                            .child(Label::new("API key"))
                            .child(form.key.clone()),
                    )
                    .when(
                        crate::intern_model::subscription_provider_id(&form.intern.provider).is_some(),
                        |card| {
                            let provider = crate::intern_model::subscription_provider(&form.intern.provider, cx);
                            let models = provider.as_ref().map(|provider| provider.provided_models(cx)).unwrap_or_default();
                            let selected = form.model.read(cx).text(cx);
                            let selected_label = models.iter().find(|model| model.id.0.as_ref() == selected)
                                .map(|model| model.name.0.to_string()).unwrap_or_else(|| {
                                    if selected.is_empty() { "Account default".into() } else { selected.clone() }
                                });
                            let model_page = cx.weak_entity();
                            let model_menu = ContextMenu::build(window, cx, move |mut menu, _, _| {
                                let choices = std::iter::once((String::new(), "Account default".to_owned()))
                                    .chain(models.iter().map(|model| (model.id.0.to_string(), model.name.0.to_string())));
                                for (id, name) in choices {
                                    let page = model_page.clone();
                                    menu.push_item(ContextMenuEntry::new(name).handler(move |window, cx| {
                                        if let Some(task) = page.update(cx, |page, cx| {
                                            page.change_setting(index, InternSetting::Model(id.clone()), window, cx)
                                        }).log_err() {
                                            task.detach_and_log_err(cx);
                                        }
                                    }));
                                }
                                menu
                            });
                            card
                                .child(Label::new("Account"))
                                .child(Label::new("Interns on this provider share your account and usage limits.")
                                    .size(LabelSize::Small).color(Color::Muted))
                                .when_some(form.account.clone(), |card, account| card.child(account))
                                .when(form.account.is_none(), |card| card.child(Label::new("Account connection unavailable.").color(Color::Error)))
                                .child(Label::new("Model"))
                                .child(DropdownMenu::new(("subscription-model", index), selected_label, model_menu)
                                    .style(DropdownStyle::Outlined).full_width(true))
                        },
                    )
                    )
                    .child(h_flex().mt_3().gap_1()
                        .child(Button::new(("skills", index), format!("{} Skills ({})", if form.skills_expanded { "▾" } else { "▸" }, form.intern.skills.len()))
                            .on_click(cx.listener(move |page, _, _, cx| {
                                if let Some(form) = page.forms.get_mut(index) { form.skills_expanded = !form.skills_expanded; }
                                cx.notify();
                            })))
                        .child(ui::IconButton::new(("import", index), IconName::Plus)
                            .tooltip(ui::Tooltip::text("Add skill files"))
                            .on_click(cx.listener(move |page, _, window, cx| page.import(index, window, cx)))));
                if form.skills_expanded {
                    if form.intern.skills.is_empty() {
                        card = card.child(
                            Label::new("No skills yet.")
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        );
                    }
                    for (skill_index, skill) in form.intern.skills.iter().enumerate() {
                        card = card.child(
                            h_flex()
                                .justify_between()
                                .child(Label::new(format!(
                                    "{} · {} · unlocked",
                                    skill.name,
                                    match skill.source {
                                        SkillSource::HumanExample { .. } => "Learned",
                                        SkillSource::Imported { .. } => "Imported",
                                    }
                                )))
                                .child(
                                    Button::new(
                                        gpui::ElementId::Name(
                                            format!("remove-skill-{index}-{skill_index}").into(),
                                        ),
                                        "Remove",
                                    )
                                    .on_click(cx.listener(
                                        move |page, _, window, cx| {
                                            if let Some(form) = page.forms.get_mut(index) {
                                                if skill_index < form.intern.skills.len() {
                                                    form.intern.skills.remove(skill_index);
                                                }
                                            }
                                            page.queue_autosave(window, cx);
                                            cx.notify();
                                        },
                                    )),
                                ),
                        );
                    }
                }
                let page = cx.weak_entity();
                let has_learned = form
                    .intern
                    .skills
                    .iter()
                    .any(|skill| matches!(skill.source, SkillSource::HumanExample { .. }));
                let export_menu = ContextMenu::build(window, cx, move |mut menu, _, _| {
                    for (label, include_learned) in [
                        ("Export intern", false),
                        ("Export with learned skills…", true),
                    ] {
                        if include_learned && !has_learned {
                            continue;
                        }
                        let page = page.clone();
                        menu.push_item(ContextMenuEntry::new(label).handler(move |window, cx| {
                            page.update(cx, |page, cx| {
                                page.export_intern(index, include_learned, window, cx)
                            })
                            .log_err();
                        }));
                    }
                    menu
                });
                card = card.child(DropdownMenu::new(
                    ("export-intern", index),
                    "Export intern",
                    export_menu,
                ));
                if form.intern.id != "dum-intern" {
                    card = card.child(
                        Button::new(("delete-intern", index), "Delete intern").on_click(
                            cx.listener(move |page, _, window, cx| {
                                if index < page.forms.len() {
                                    page.forms.remove(index);
                                    page.selected =
                                        page.selected.min(page.forms.len().saturating_sub(1));
                                }
                                page.queue_autosave(window, cx);
                                cx.notify();
                            }),
                        ),
                    );
                }
            }
            cards.push(card);
        }
        v_flex()
            .id("interns-page")
            .track_focus(&self.focus)
            .size_full()
            .min_h_0()
            .bg(cx.theme().colors().editor_background)
            .child(
                h_flex()
                    .flex_shrink_0()
                    .justify_between()
                    .px_4()
                    .py_3()
                    .border_b_1()
                    .border_color(cx.theme().colors().border)
                    .child(
                        h_flex().gap_2().child(Label::new("Interns")).child(
                            Label::new(self.forms.len().to_string())
                                .size(LabelSize::Small)
                                .color(Color::Muted),
                        ),
                    ),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_start()
                    .child(
                        v_flex()
                            .id("intern-roster")
                            .w(px(184.))
                            .h_full()
                            .flex_shrink_0()
                            .min_h_0()
                            .p_2()
                            .gap_1()
                            .border_r_1()
                            .border_color(cx.theme().colors().border)
                            .child(
                                Button::new("add-intern", "Add bot")
                                    .start_icon(Icon::new(IconName::Plus))
                                    .full_width()
                                    .disabled(self.saving)
                                    .on_click(cx.listener(|page, _, window, cx| {
                                        page.add_intern(window, cx)
                                    })),
                            )
                            .child(
                                Button::new("import-intern", "Import intern")
                                    .full_width()
                                    .disabled(self.saving)
                                    .on_click(cx.listener(|page, _, window, cx| {
                                        page.import_intern(window, cx)
                                    })),
                            )
                            .child(
                                v_flex()
                                    .id("intern-list")
                                    .flex_1()
                                    .min_h_0()
                                    .w_full()
                                    .overflow_y_scroll()
                                    .children(roster),
                            ),
                    )
                    .child(
                        v_flex()
                            .id("intern-details")
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p_4()
                            .gap_3()
                            .children(cards),
                    ),
            )
            .child(
                h_flex()
                    .flex_shrink_0()
                    .h(px(26.))
                    .px_4()
                    .border_t_1()
                    .border_color(cx.theme().colors().border)
                    .child(
                        Label::new(if self.message.is_empty() {
                            SharedString::from("All changes save automatically.")
                        } else {
                            self.message.clone()
                        })
                        .size(LabelSize::Small)
                        .color(Color::Muted)
                        .truncate(),
                    ),
            )
    }
}

struct InternsButton;
impl Render for InternsButton {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Button::new("interns", "Interns")
            .on_click(|_, window, cx| window.dispatch_action(Box::new(Manage), cx))
    }
}
impl workspace::StatusItemView for InternsButton {
    fn set_active_pane_item(
        &mut self,
        _: Option<&dyn workspace::ItemHandle>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
    }
    fn hide_setting(&self, _: &App) -> Option<workspace::HideStatusItem> {
        None
    }
}

#[cfg(test)]
pub(crate) fn set_test_policy(policy: SkillPolicy, cx: &mut App) {
    cx.global_mut::<Registry>().config.interns[0].policy = policy;
}

#[cfg(test)]
pub(crate) fn import_test_skill(path: &Path, cx: &mut App) {
    cx.global_mut::<Registry>().config.interns[0]
        .import_skill(path)
        .expect("valid test skill");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn portable_intern() -> Intern {
        let mut intern = InternConfig::default().interns.remove(0);
        intern.description = "Prefer descriptive names.".into();
        intern.appearance = InternAppearance {
            shape: AvatarShape::Bloom,
            color: AvatarColor::Mint,
        };
        intern.policy = SkillPolicy::Unrestricted;
        intern.provider = "private-provider".into();
        intern.model = "private-model".into();
        intern.endpoint = "https://private-endpoint.example?token=secret".into();
        intern.skills.push(Skill {
            name: "frontend".into(),
            source: SkillSource::Imported {
                filename: "frontend.md".into(),
                content: "Use semantic HTML.".into(),
            },
        });
        intern
            .learn_human_example("parallel-upload".into(), "private human code".into())
            .expect("learn example");
        intern
    }

    #[test]
    fn packages_round_trip_without_connections_or_learned_examples_by_default() -> Result<()> {
        let original = portable_intern();
        let json = InternPackage::encode(&original, false)?;
        for excluded in [
            "private-provider",
            "private-model",
            "private-endpoint",
            "private human code",
            "api_key",
            "access_token",
            "\"id\"",
        ] {
            assert!(!json.contains(excluded), "export contained {excluded}");
        }
        let imported = InternPackage::decode(json.as_bytes())?;
        assert_ne!(original.id, imported.id);
        assert_ne!(original.credential_service(), imported.credential_service());
        assert!(imported.provider.is_empty());
        assert!(imported.model.is_empty() && imported.endpoint.is_empty());
        assert_eq!(imported.appearance, original.appearance);
        assert_eq!(imported.description, original.description);
        assert_eq!(imported.policy, original.policy);
        assert_eq!(imported.skills, original.skills[..1]);
        let with_learned = InternPackage::encode(&original, true)?;
        assert_eq!(
            InternPackage::decode(with_learned.as_bytes())?.skills,
            original.skills
        );
        assert_ne!(InternPackage::decode(json.as_bytes())?.id, imported.id);
        Ok(())
    }

    #[test]
    fn packages_reject_invalid_versions_names_skills_and_oversized_files() -> Result<()> {
        let json = InternPackage::encode(&portable_intern(), false)?;
        let value: serde_json::Value = serde_json::from_str(&json)?;
        for (field, invalid) in [
            ("version", serde_json::json!(99)),
            ("format", serde_json::json!("other")),
            ("name", serde_json::json!("../escape")),
            ("api_key", serde_json::json!("must-not-import")),
            (
                "skills",
                serde_json::json!([value["skills"][0].clone(), value["skills"][0].clone()]),
            ),
        ] {
            let mut malformed = value.clone();
            malformed[field] = invalid;
            assert!(InternPackage::decode(&serde_json::to_vec(&malformed)?).is_err());
        }
        assert!(InternPackage::decode(b"broken JSON").is_err());
        assert!(InternPackage::decode(&vec![b' '; INTERN_PACKAGE_LIMIT + 1]).is_err());
        let tree = util::test::TempTree::new(
            serde_json::json!({"bad.intern": "broken JSON", "wrong.txt": json}),
        );
        assert!(InternPackage::read(&tree.path().join("bad.intern")).is_err());
        assert!(InternPackage::read(&tree.path().join("wrong.txt")).is_err());
        Ok(())
    }

    #[gpui::test]
    async fn importing_a_package_creates_and_autosaves_unique_local_profiles(
        cx: &mut gpui::TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        let tree = util::test::TempTree::new(serde_json::json!({
            "dum.intern": InternPackage::encode(&portable_intern(), false).expect("encode package")
        }));
        let mut context = crate::test::editor_test_context::EditorTestContext::new(cx).await;
        let page = context.update(|window, cx| cx.new(|cx| InternsPage::new(window, cx)));
        for expected_name in ["dum-intern-2", "dum-intern-3"] {
            context.update(|window, cx| page.update(cx, |page, cx| page.import_intern(window, cx)));
            context.cx.simulate_path_prompt_response(|options| {
                assert!(options.files && !options.directories && !options.multiple);
                Some(vec![tree.path().join("dum.intern")])
            });
            context.run_until_parked();
            for _ in 0..3 {
                context
                    .cx
                    .executor()
                    .advance_clock(Duration::from_millis(500));
                context.run_until_parked();
            }
            context.update(|_, cx| {
                let imported = profile(expected_name, cx).expect("import should persist");
                assert_ne!(imported.id, "dum-intern");
                assert_eq!(imported.skills.len(), 1);
                assert_eq!(imported.description, "Prefer descriptive names.");
                assert!(imported.provider.is_empty());
                assert!(page.read(cx).forms[page.read(cx).selected].connection_expanded);
            });
        }
        context.update(|window, cx| page.update(cx, |page, cx| page.import_intern(window, cx)));
        context.cx.simulate_path_prompt_response(|_| None);
        context.run_until_parked();
        context.update(|_, cx| assert_eq!(page.read(cx).forms.len(), 3));
    }

    #[test]
    fn description_preserves_formatting_and_reads_older_instruction_fields() -> Result<()> {
        let mut intern = portable_intern();
        intern.description =
            "\nA patient pair programmer.\n\n  Keep explanations brief.\n\n".into();
        let json = InternPackage::encode(&intern, false)?;
        assert!(json.contains("\"description\""));
        assert!(!json.contains("\"instructions\""));
        assert_eq!(
            InternPackage::decode(json.as_bytes())?.description,
            intern.description
        );
        let legacy_package = json.replace("\"description\"", "\"instructions\"");
        assert_eq!(
            InternPackage::decode(legacy_package.as_bytes())?.description,
            intern.description
        );
        let legacy_profile =
            serde_json::to_string(&intern)?.replace("\"description\"", "\"instructions\"");
        assert_eq!(
            serde_json::from_str::<Intern>(&legacy_profile)?.description,
            intern.description
        );
        Ok(())
    }

    #[gpui::test]
    async fn description_autosaves_blank_lines_and_indentation(cx: &mut gpui::TestAppContext) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = crate::test::editor_test_context::EditorTestContext::new(cx).await;
        let page = context.update(|window, cx| cx.new(|cx| InternsPage::new(window, cx)));
        let description = "\nYour role: frontend helper.\n\n  Prefer readable components.\n\n";
        context.update(|window, cx| {
            let field = page.read(cx).forms[0].description.clone();
            field.update(cx, |field, cx| field.set_text(description, window, cx));
        });
        context.run_until_parked();
        for _ in 0..3 {
            context
                .cx
                .executor()
                .advance_clock(Duration::from_millis(500));
            context.run_until_parked();
        }
        context.update(|window, cx| {
            assert_eq!(
                profile("dum-intern", cx).expect("saved intern").description,
                description
            );
            let reopened = cx.new(|cx| InternsPage::new(window, cx));
            assert_eq!(
                reopened.read(cx).forms[0].description.read(cx).text(cx),
                description
            );
        });
    }

    #[gpui::test]
    async fn text_edits_autosave_and_invalid_names_keep_the_last_valid_profile(
        cx: &mut gpui::TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = crate::test::editor_test_context::EditorTestContext::new(cx).await;
        let page = context.update(|window, cx| cx.new(|cx| InternsPage::new(window, cx)));
        context.update(|window, cx| {
            let name = page.read(cx).forms[0].name.clone();
            name.update(cx, |field, cx| field.set_text("auto-name", window, cx));
        });
        context.run_until_parked();
        for _ in 0..3 {
            context
                .cx
                .executor()
                .advance_clock(Duration::from_millis(500));
            context.run_until_parked();
        }
        context.update(|_, cx| assert!(profile("auto-name", cx).is_some()));
        context.update(|window, cx| {
            let name = page.read(cx).forms[0].name.clone();
            name.update(cx, |field, cx| field.set_text("invalid name", window, cx));
        });
        context.run_until_parked();
        for _ in 0..3 {
            context
                .cx
                .executor()
                .advance_clock(Duration::from_millis(500));
            context.run_until_parked();
        }
        context.update(|_, cx| {
            assert!(profile("auto-name", cx).is_some());
            assert!(profile("invalid name", cx).is_none());
            assert!(page.read(cx).message.contains("Intern names"));
        });
    }

    #[gpui::test]
    async fn policy_toggle_reaches_assignments_without_saving_other_drafts(
        cx: &mut gpui::TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = crate::test::editor_test_context::EditorTestContext::new(cx).await;
        let page = context.update(|window, cx| cx.new(|cx| InternsPage::new(window, cx)));
        context.update(|window, cx| {
            page.update(cx, |page, cx| {
                let form = page.forms.first().expect("shipped intern");
                form.name
                    .update(cx, |field, cx| field.set_text("draft-name", window, cx));
                form.model
                    .update(cx, |field, cx| field.set_text("draft-model", window, cx));
                form.key.update(cx, |field, cx| {
                    field.set_text("test-only-draft-key", window, cx)
                });
            })
        });
        let save = context.update(|window, cx| {
            page.update(cx, |page, cx| {
                page.change_setting(
                    0,
                    InternSetting::Policy(SkillPolicy::Unrestricted),
                    window,
                    cx,
                )
            })
        });
        save.await.expect("save skill policy");
        context.update(|_, cx| {
            let active = profile("dum-intern", cx).expect("active intern");
            assert_eq!(active.policy, SkillPolicy::Unrestricted);
            assert_ne!(active.model, "draft-model");
            assert!(profile("draft-name", cx).is_none());
            page.read_with(cx, |page, cx| {
                assert_eq!(page.forms[0].key.read(cx).text(cx), "test-only-draft-key");
                assert!(page.is_dirty(cx));
            });
        });
        let called = std::sync::Arc::new(parking_lot::Mutex::new(false));
        let called_by_model = called.clone();
        context.update(|_, cx| {
            cx.set_global(crate::intern_model::InternModelFactory(
                std::sync::Arc::new(move |_, _| {
                    *called_by_model.lock() = true;
                    anyhow::bail!("Reached the model connection")
                }),
            ))
        });
        context.set_state("ˇ\n");
        context.update_editor(|editor, window, cx| {
            editor.handle_input("@", window, cx);
            let input = editor
                .pending_inline_input()
                .expect("mention composer")
                .editor
                .clone();
            input.update(cx, |input, cx| {
                input.set_text("dum-intern write a double function", window, cx)
            });
            editor.confirm_inline_input(window, cx);
        });
        context.run_until_parked();
        assert!(
            *called.lock(),
            "unrestricted policy must reach the model with zero skills"
        );
    }

    #[gpui::test]
    async fn provider_and_model_switch_reach_assignments_without_saving_other_drafts(
        cx: &mut gpui::TestAppContext,
    ) {
        crate::editor_tests::init_test(cx, |_| {});
        let mut context = crate::test::editor_test_context::EditorTestContext::new(cx).await;
        context.update(|_, cx| {
            let intern = &mut cx.global_mut::<Registry>().config.interns[0];
            intern.provider = "DeepSeek".into();
            intern.model = "deepseek-flash".into();
            intern.endpoint = "https://api.deepseek.com".into();
            intern.policy = SkillPolicy::Unrestricted;
        });
        let page = context.update(|window, cx| cx.new(|cx| InternsPage::new(window, cx)));
        context.update(|window, cx| {
            page.update(cx, |page, cx| {
                page.forms[0]
                    .name
                    .update(cx, |field, cx| field.set_text("draft-name", window, cx));
            });
        });
        for setting in [
            InternSetting::Provider("SuperGrok".into()),
            InternSetting::Model("grok-4.7".into()),
            InternSetting::Appearance(InternAppearance {
                shape: AvatarShape::Bloom,
                color: AvatarColor::Violet,
            }),
        ] {
            let save = context.update(|window, cx| {
                page.update(cx, |page, cx| page.change_setting(0, setting, window, cx))
            });
            save.await.expect("save selected connection");
        }
        context.update(|_, cx| {
            let active = profile("dum-intern", cx).expect("active intern");
            assert_eq!(active.provider, "SuperGrok");
            assert_eq!(active.model, "grok-4.7");
            assert_eq!(active.appearance.shape, AvatarShape::Bloom);
            assert_eq!(active.appearance.color, AvatarColor::Violet);
            assert!(active.endpoint.is_empty());
            assert!(profile("draft-name", cx).is_none());
            assert!(page.read(cx).is_dirty(cx));
        });
        let called = std::sync::Arc::new(parking_lot::Mutex::new(None));
        let called_by_model = called.clone();
        context.update(|_, cx| {
            cx.set_global(crate::intern_model::InternModelFactory(
                std::sync::Arc::new(move |intern, _| {
                    *called_by_model.lock() = Some((intern.provider.clone(), intern.model.clone()));
                    anyhow::bail!("Reached selected provider")
                }),
            ));
        });
        context.set_state("ˇ\n");
        context.update_editor(|editor, window, cx| {
            editor.handle_input("@", window, cx);
            let input = editor
                .pending_inline_input()
                .expect("mention composer")
                .editor
                .clone();
            input.update(cx, |input, cx| {
                input.set_text("dum-intern write a double function", window, cx)
            });
            editor.confirm_inline_input(window, cx);
        });
        context.run_until_parked();
        assert_eq!(
            *called.lock(),
            Some(("SuperGrok".into(), "grok-4.7".into()))
        );
    }

    #[test]
    fn character_settings_preserve_older_profiles_and_round_trip() {
        let mut intern = Intern::new("dum".into());
        let service = intern.credential_service();
        intern.appearance = InternAppearance {
            shape: AvatarShape::Bloom,
            color: AvatarColor::Violet,
        };
        let mut json = serde_json::to_value(&intern).expect("serialize character");
        let restored: Intern = serde_json::from_value(json.clone()).expect("restore character");
        assert_eq!(restored.appearance, intern.appearance);
        assert_eq!(restored.credential_service(), service);
        json.as_object_mut()
            .expect("profile object")
            .remove("appearance");
        let older: Intern = serde_json::from_value(json).expect("older profile");
        assert_eq!(older.appearance, InternAppearance::default());
    }

    #[test]
    fn deepseek_has_its_own_preset_and_credentials() {
        let (model, endpoint) = provider_defaults("DeepSeek");
        assert_eq!(model, "deepseek-flash");
        assert_eq!(endpoint, "https://api.deepseek.com");
        let mut intern = Intern::new("frontend".into());
        let previous_service = intern.credential_service();
        intern.provider = "DeepSeek".into();
        assert_ne!(intern.credential_service(), previous_service);
        let default_endpoint_service = intern.credential_service();
        intern.endpoint = "https://other.example".into();
        assert_ne!(intern.credential_service(), default_endpoint_service);
    }

    #[test]
    fn restrictions_are_per_intern_and_imports_unlock_skills() {
        let mut restricted = InternConfig::default().interns.remove(0);
        let mut unrestricted = Intern::new("frontend".into());
        unrestricted.policy = SkillPolicy::Unrestricted;
        assert_eq!(restricted.missing_skills(["frontend"]), ["frontend"]);
        assert!(unrestricted.missing_skills(["frontend"]).is_empty());
        restricted.skills.push(Skill {
            name: "frontend".into(),
            source: SkillSource::Imported {
                filename: "frontend.md".into(),
                content: "Build readable components.".into(),
            },
        });
        assert!(restricted.missing_skills(["frontend"]).is_empty());
        assert_eq!(
            restricted.missing_skills(["database", "frontend"]),
            ["database"]
        );
    }

    #[test]
    fn imports_keep_the_guidance_and_validate_profile_names() {
        let mut config = InternConfig::default();
        config.interns[0]
            .import_skill(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../demo/skills/frontend.md")
                    .as_path(),
            )
            .expect("import frontend skill");
        assert!(config.interns[0].missing_skills(["frontend"]).is_empty());
        assert!(
            matches!(&config.interns[0].skills[0].source, SkillSource::Imported {content, ..} if content.contains("semantic HTML"))
        );
        config.interns.push(Intern::new("dum-intern".into()));
        assert!(config.validate().is_err());
        config.interns[1].name = "invalid name".into();
        assert!(config.validate().is_err());
    }

    #[test]
    fn saved_profiles_preserve_policy_and_provenance() {
        let mut config = InternConfig::default();
        config.interns[0]
            .learn_human_example("parallel-upload".into(), "human edit 42".into())
            .expect("valid example");
        let mut intern = Intern::new("frontend".into());
        intern.policy = SkillPolicy::Unrestricted;
        config.interns.push(intern);
        let json = serde_json::to_string(&config).expect("serialize config");
        assert!(!json.contains("api_key"));
        let restored: InternConfig = serde_json::from_str(&json).expect("deserialize config");
        restored.validate().expect("valid config");
        assert_eq!(restored.interns[0].policy, SkillPolicy::Restricted);
        assert_eq!(restored.interns[1].policy, SkillPolicy::Unrestricted);
        assert!(matches!(
            restored.interns[0].skills[0].source,
            SkillSource::HumanExample { .. }
        ));
    }
}
