use tauri::AppHandle;
use windows::{
    core::{IInspectable, Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, IReference, PropertyValue, TypedEventHandler},
    UI::Notifications::{
        ToastActivatedEventArgs, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
};

use super::{report_action, Action, IncomingCall};

pub(super) struct Notification {
    toast: ToastNotification,
    notifier: ToastNotifier,
    activation: i64,
    tag: HSTRING,
    app_id: HSTRING,
}

impl Notification {
    pub(super) async fn show(
        app: &AppHandle,
        call: &IncomingCall,
        remaining: u64,
    ) -> Result<Self, String> {
        Self::post(app.clone(), call, remaining).map_err(|error| error.to_string())
    }

    fn post(app: AppHandle, call: &IncomingCall, remaining: u64) -> windows::core::Result<Self> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(concat!(
            r#"<toast scenario="incomingCall" launch="open">"#,
            r#"<visual><binding template="ToastGeneric"><text>Incoming call</text><text/></binding></visual>"#,
            r#"<actions><action content="Answer" arguments="answer"/>"#,
            r#"<action content="Decline" arguments="decline"/></actions><audio silent="true"/></toast>"#,
        )))?;
        xml.GetElementsByTagName(&HSTRING::from("text"))?
            .Item(1)?
            .AppendChild(&xml.CreateTextNode(&HSTRING::from(&call.caller))?)?;

        let toast = ToastNotification::CreateToastNotification(&xml)?;
        // WinRT uses 100 ns ticks since 1601. This also expires the toast if Pax exits.
        let expires_at = crate::voice_presence::now_ms() + remaining;
        let expiration: IReference<DateTime> = PropertyValue::CreateDateTime(DateTime {
            UniversalTime: (expires_at as i64 * 10_000) + 116_444_736_000_000_000,
        })?
        .cast()?;
        toast.SetExpirationTime(&expiration)?;
        let tag = HSTRING::from(call.call_id.simple().to_string());
        toast.SetTag(&tag)?;
        toast.SetGroup(&HSTRING::from("Pax calls"))?;
        let app_id = HSTRING::from(&app.config().identifier);
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app_id)?;
        let call_id = call.call_id;
        let activation = toast.Activated(
            &TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
                let Some(args) = args.as_ref() else {
                    return Ok(());
                };
                let args: ToastActivatedEventArgs = args.cast()?;
                let action = match args.Arguments()?.to_string().as_str() {
                    "answer" => Action::Answer,
                    "decline" => Action::Decline,
                    _ => Action::Open,
                };
                report_action(&app, call_id, action);
                Ok(())
            }),
        )?;
        notifier.Show(&toast)?;
        Ok(Self {
            toast,
            notifier,
            activation,
            tag,
            app_id,
        })
    }

    pub(super) async fn close(self) {
        let _ = self.toast.RemoveActivated(self.activation);
        let _ = self.notifier.Hide(&self.toast);
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(
                &self.tag,
                &HSTRING::from("Pax calls"),
                &self.app_id,
            );
        }
    }
}
