use serde::{Deserialize, Serialize};

pub(super) const SCHEMA_VERSION: u16 = 1;
pub(super) const MAX_DEVICES: usize = 8;
pub(super) const MAX_FEATURES_PER_DEVICE: usize = 8;
pub(super) const MAX_TOTAL_FEATURES: usize = 32;
pub(super) const MAX_STEP_COUNT: u32 = 10_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InitializeRequest {
    pub schema_version: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FenceRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub topology_generation: u64,
    pub safety_generation: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeviceRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub topology_generation: u64,
    pub safety_generation: u64,
    pub device_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct VibrateRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub topology_generation: u64,
    pub safety_generation: u64,
    pub device_id: String,
    pub feature_id: String,
    pub intensity: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StopFeatureRequest {
    pub schema_version: u16,
    pub device_id: String,
    pub feature_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct GlobalRequest {
    pub schema_version: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InitializeResponse {
    pub schema_version: u16,
    pub session_id: String,
    pub topology_generation: u64,
    pub safety_generation: u64,
    pub scanning: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScanAck {
    pub schema_version: u16,
    pub session_id: String,
    pub topology_generation: u64,
    pub safety_generation: u64,
    pub scanning: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum HardwareState {
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OperationAck {
    pub schema_version: u16,
    pub session_id: String,
    pub topology_generation: u64,
    pub safety_generation: u64,
    pub acknowledged: bool,
    pub hardware_state: HardwareState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_intensity: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GlobalAck {
    pub schema_version: u16,
    pub acknowledged: bool,
    pub hardware_state: HardwareState,
    pub session_id: Option<String>,
    pub topology_generation: Option<u64>,
    pub safety_generation: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeDevice {
    pub native_device_id: String,
    pub name: String,
    pub capabilities: Vec<NativeCapability>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum NativeCapability {
    Vibrate {
        native_feature_id: String,
        step_count: u32,
    },
    Battery {
        native_feature_id: String,
        value: Option<f64>,
    },
    Rssi {
        native_feature_id: String,
        value: Option<i16>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum NativeEvent {
    Topology {
        schema_version: u16,
        session_id: String,
        topology_generation: u64,
        safety_generation: u64,
        devices: Vec<NativeDevice>,
    },
    SessionEnded {
        schema_version: u16,
        session_id: String,
        topology_generation: u64,
        safety_generation: u64,
        reason: String,
    },
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

pub(super) fn validate_intensity(intensity: f64) -> Result<(), GateError> {
    if intensity.is_finite() && (0.0..=1.0).contains(&intensity) {
        Ok(())
    } else {
        Err(GateError::new(
            "invalid_intensity",
            "intensity must be a finite number in 0..1",
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

        let vibrate = r#"{
            "schemaVersion":1,
            "sessionId":"session",
            "topologyGeneration":2,
            "safetyGeneration":3,
            "deviceId":"device",
            "featureId":"feature",
            "intensity":0.5,
            "bytes":[1,2,3]
        }"#;
        assert!(serde_json::from_str::<VibrateRequest>(vibrate).is_err());
    }

    #[test]
    fn rejects_stale_schema_versions_and_invalid_intensity() {
        let error = validate_schema(2).expect_err("schema 2 must stay unavailable");
        assert_eq!(error.code, "unsupported_schema");
        for intensity in [f64::NAN, f64::INFINITY, -0.01, 1.01] {
            assert!(validate_intensity(intensity).is_err());
        }
    }

    #[test]
    fn hardware_ack_never_claims_confirmed_state() {
        let ack = GlobalAck {
            schema_version: SCHEMA_VERSION,
            acknowledged: true,
            hardware_state: HardwareState::Unknown,
            session_id: None,
            topology_generation: None,
            safety_generation: None,
        };
        let value = serde_json::to_value(ack).unwrap();
        assert_eq!(value["hardwareState"], "unknown");
    }

    #[test]
    fn topology_wire_shape_matches_the_shared_backend_contract() {
        let event = NativeEvent::Topology {
            schema_version: SCHEMA_VERSION,
            session_id: "opaque-session".to_owned(),
            topology_generation: 4,
            safety_generation: 5,
            devices: vec![NativeDevice {
                native_device_id: "opaque-device".to_owned(),
                name: "Device".to_owned(),
                capabilities: vec![NativeCapability::Battery {
                    native_feature_id: "opaque-feature".to_owned(),
                    value: None,
                }],
            }],
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "topology");
        assert_eq!(
            value["devices"][0]["capabilities"][0]["value"],
            serde_json::Value::Null
        );
        assert!(value["devices"][0].get("address").is_none());
    }
}
