use anyhow::{Result, bail};
use credentials_provider::CredentialsProvider;
use editor::{intern_model::InternModelFactory, interns::Intern};
use gpui::{App, AsyncApp};
use http_client::HttpClient;
use language_model::LanguageModelProvider;
use std::{future::Future, pin::Pin, sync::Arc};

struct InternCredentials {
    service: String,
    endpoint: String,
    legacy_service: Option<String>,
}

impl CredentialsProvider for InternCredentials {
    fn read_credentials<'a>(
        &'a self,
        url: &'a str,
        cx: &'a AsyncApp,
    ) -> Pin<Box<dyn Future<Output = Result<Option<(String, Vec<u8>)>>> + 'a>> {
        Box::pin(async move {
            if url.trim_end_matches('/') != self.endpoint.trim_end_matches('/') {
                bail!("The provider endpoint changed. Save this intern's key again.");
            }
            let credentials = cx.update(|cx| cx.read_credentials(&self.service)).await?;
            if credentials.is_some() {
                return Ok(credentials);
            }
            if let Some(legacy) = &self.legacy_service {
                return cx.update(|cx| cx.read_credentials(legacy)).await;
            }
            Ok(None)
        })
    }

    fn write_credentials<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a [u8],
        _: &'a AsyncApp,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { bail!("Manage this intern's API key in the Interns tab.") })
    }

    fn delete_credentials<'a>(
        &'a self,
        _: &'a str,
        _: &'a AsyncApp,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { bail!("Manage this intern's API key in the Interns tab.") })
    }
}

pub fn init(http_client: Arc<dyn HttpClient>, cx: &mut App) {
    cx.set_global(InternModelFactory(Arc::new(move |intern: &Intern, cx| {
        if editor::intern_model::subscription_provider_id(&intern.provider).is_some() {
            return editor::intern_model::subscription_provider(&intern.provider, cx)
                .ok_or_else(|| anyhow::anyhow!("This subscription provider is unavailable."));
        }
        if intern.provider != "DeepSeek" {
            bail!(
                "Choose ChatGPT Subscription, SuperGrok, or DeepSeek in Interns to run assignments."
            );
        }
        let endpoint = if intern.endpoint.is_empty() {
            "https://api.deepseek.com"
        } else {
            intern.endpoint.as_str()
        };
        let credentials = Arc::new(InternCredentials {
            service: intern.credential_service(),
            endpoint: endpoint.to_owned(),
            legacy_service: (endpoint.trim_end_matches('/') == "https://api.deepseek.com")
                .then(|| format!("dum/interns/{}/DeepSeek", intern.id)),
        });
        let provider =
            language_models::provider::deepseek::DeepSeekLanguageModelProvider::for_intern(
                http_client.clone(),
                credentials,
                endpoint.trim_end_matches('/').to_owned().into(),
                cx,
            );
        Ok(Arc::new(provider) as Arc<dyn LanguageModelProvider>)
    })));
}
