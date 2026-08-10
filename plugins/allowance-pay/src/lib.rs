pub mod pay;

pub const PLUGIN_NAME: &str = "safespend-allowance-pay";
pub const TOOL_NAME: &str = "safespend_allowance_pay";

#[cfg(target_family = "wasm")]
mod component {
    wit_bindgen::generate!({
        path: "../../wit/safespend-tool-v0",
        world: "tool-plugin",
        features: ["plugins-wit-v0"],
    });

    use exports::zeroclaw::plugin::plugin_info::Guest as PluginInfo;
    use exports::zeroclaw::plugin::tool::{Guest as Tool, ToolResult};
    use std::collections::HashMap;
    use zeroize::{Zeroize, Zeroizing};

    use crate::pay::{execute_payment, PayConfig, PayError, RpcTransport};

    struct AllowancePay;

    struct WakiTransport;

    impl RpcTransport for WakiTransport {
        fn post_json(
            &self,
            url: &str,
            body: &serde_json::Value,
        ) -> Result<(u16, Vec<u8>), PayError> {
            let response = waki::Client::new()
                .post(url)
                .json(body)
                .connect_timeout(std::time::Duration::from_secs(5))
                .send()
                .map_err(|_| PayError::Transport)?;
            let status = response.status_code();
            let bytes = response.body().map_err(|_| PayError::Transport)?;
            Ok((status, bytes))
        }

        fn get(&self, url: &str) -> Result<(u16, Vec<u8>), PayError> {
            let response = waki::Client::new()
                .get(url)
                .connect_timeout(std::time::Duration::from_secs(5))
                .send()
                .map_err(|_| PayError::Transport)?;
            let status = response.status_code();
            let bytes = response.body().map_err(|_| PayError::Transport)?;
            Ok((status, bytes))
        }
    }

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ExecuteArgs {
        vendor_id: String,
        amount_base_units: u64,
        #[serde(rename = "__config", default)]
        config: HashMap<String, String>,
    }

    impl PluginInfo for AllowancePay {
        fn plugin_name() -> String {
            super::PLUGIN_NAME.to_string()
        }

        fn plugin_version() -> String {
            env!("CARGO_PKG_VERSION").to_string()
        }
    }

    impl Tool for AllowancePay {
        fn name() -> String {
            super::TOOL_NAME.to_string()
        }

        fn description() -> String {
            "Pay one approved founder expense only when both the hard-capped onchain \
             allowance and the protected post-payment runway floor permit it. The caller \
             supplies only a vendor id and exact amount."
                .to_string()
        }

        fn parameters_schema() -> String {
            serde_json::json!({
                "type": "object",
                "properties": {
                    "vendor_id": {
                        "type": "string",
                        "description": "Operator-configured vendor id. Never pass a wallet address."
                    },
                    "amount_base_units": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Exact token amount in base units; must equal protected policy."
                    }
                },
                "required": ["vendor_id", "amount_base_units"],
                "additionalProperties": false
            })
            .to_string()
        }

        fn execute(args: String) -> Result<ToolResult, String> {
            let args = Zeroizing::new(args);
            let mut parsed: ExecuteArgs = match serde_json::from_str(&args) {
                Ok(value) => value,
                Err(_) => return failure("invalid payment arguments".into()),
            };
            let config = match PayConfig::from_section(&parsed.config) {
                Ok(value) => value,
                Err(error) => return failure(error.to_string()),
            };
            if let Some(mut injected_secret_copy) = parsed.config.remove("session_key_base58") {
                injected_secret_copy.zeroize();
            }
            let request = safespend_core::PaymentRequest {
                vendor_id: parsed.vendor_id,
                amount_base_units: parsed.amount_base_units,
            };
            match execute_payment(&WakiTransport, &config, &request) {
                Ok(output) => Ok(ToolResult {
                    success: true,
                    output: serde_json::to_string(&output)
                        .map_err(|_| "failed to serialize payment result".to_string())?,
                    error: None,
                }),
                Err(error) => failure(error.to_string()),
            }
        }
    }

    fn failure(message: String) -> Result<ToolResult, String> {
        Ok(ToolResult {
            success: false,
            output: String::new(),
            error: Some(message),
        })
    }

    export!(AllowancePay);
}
