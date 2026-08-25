use serde::{Deserialize, Serialize};

pub(super) const SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InitializeRequest {
    pub schema_version: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SessionRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StopAllRequest {
    pub schema_version: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InitializeResponse {
    pub schema_version: u16,
    pub session_id: String,
    pub generation: u64,
    pub scanning: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScanAck {
    pub schema_version: u16,
    pub session_id: String,
    pub generation: u64,
    pub scanning: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceList {
    pub schema_version: u16,
    pub session_id: String,
    pub generation: u64,
    pub devices: Vec<DeviceMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceMetadata {
    pub device_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub connected: bool,
    pub capabilities: DeviceCapabilities,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceCapabilities {
    pub vibrate: bool,
    pub battery: bool,
    pub rssi: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum HardwareState {
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EmergencyStopAck {
    pub schema_version: u16,
    pub session_id: String,
    pub generation: u64,
    pub acknowledged: bool,
    pub hardware_state: HardwareState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GateError {
    pub code: &'static str,
    pub message: String,
}

impl GateError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub(super) fn validate_schema(version: u16) -> Result<(), GateError> {
    if version == SCHEMA_VERSION {
        Ok(())
    } else {
        Err(GateError::new(
            "unsupported_schema",
            format!("schemaVersion must be {SCHEMA_VERSION}"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_request_fields() {
        let input = r#"{"schemaVersion":1,"unexpected":true}"#;
        assert!(serde_json::from_str::<InitializeRequest>(input).is_err());
    }

    #[test]
    fn rejects_stale_schema_versions() {
        let error = validate_schema(2).expect_err("schema 2 must stay unavailable");
        assert_eq!(error.code, "unsupported_schema");
    }

    #[test]
    fn hardware_ack_never_claims_a_confirmed_stop() {
        let ack = EmergencyStopAck {
            schema_version: SCHEMA_VERSION,
            session_id: "opaque-session".to_owned(),
            generation: 4,
            acknowledged: true,
            hardware_state: HardwareState::Unknown,
        };
        let value = serde_json::to_value(ack).unwrap();
        assert_eq!(value["hardwareState"], "unknown");
    }
}
