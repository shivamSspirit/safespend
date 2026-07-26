pub mod watch;

pub const PLUGIN_NAME: &str = "safespend-treasury-watch";
pub const TOOL_NAME: &str = "safespend_treasury_watch";

#[cfg(target_family = "wasm")]
mod component {
    wit_bindgen::generate!({
        path: "../../wit/v0",
        world: "tool-plugin",
        features: ["plugins-wit-v0"],
    });

    use std::collections::HashMap;

    use exports::zeroclaw::plugin::plugin_info::Guest as PluginInfo;
    use exports::zeroclaw::plugin::tool::{Guest as Tool, ToolResult};
    use zeroclaw::plugin::logging::{
        log_record, LogLevel, PluginAction, PluginEvent, PluginOutcome,
    };

    use crate::watch::{execute_watch, RpcTransport, WatchArgs, WatchConfig, WatchError};

    struct TreasuryWatch;

    struct WakiTransport;

    impl RpcTransport for WakiTransport {
        fn post_json(
            &self,
            url: &str,
            body: &serde_json::Value,
        ) -> Result<(u16, Vec<u8>), WatchError> {
            let response = waki::Client::new()
                .post(url)
                .json(body)
                .connect_timeout(std::time::Duration::from_secs(5))
                .send()
                .map_err(|_| WatchError::Transport)?;
            let status = response.status_code();
            let bytes = response.body().map_err(|_| WatchError::Transport)?;
            Ok((status, bytes))
        }
    }

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ExecuteArgs {
        #[serde(default)]
        previous_snapshot: Option<safespend_core::BalanceSnapshot>,
        #[serde(default)]
        native_cursor: crate::watch::ActivityCursor,
        #[serde(default)]
        token_cursor: crate::watch::ActivityCursor,
        observed_at_ts: u64,
        #[serde(rename = "__config", default)]
        config: HashMap<String, String>,
    }

    impl PluginInfo for TreasuryWatch {
        fn plugin_name() -> String {
            super::PLUGIN_NAME.to_string()
        }

        fn plugin_version() -> String {
            env!("CARGO_PKG_VERSION").to_string()
        }
    }

    impl Tool for TreasuryWatch {
        fn name() -> String {
            super::TOOL_NAME.to_string()
        }

        fn description() -> String {
            "Read and summarize a founder's protected Solana treasury, calculated runway, \
             runway floor, and meaningful finalized changes. This tool is read-only."
                .to_string()
        }

        fn parameters_schema() -> String {
            serde_json::json!({
                "type": "object",
                "properties": {
                    "previous_snapshot": {
                        "type": ["object", "null"],
                        "description": "Last finalized snapshot returned by this tool, or null on first run."
                    },
                    "native_cursor": {
                        "type": "object",
                        "description": "Native SOL activity cursor returned by the previous call."
                    },
                    "token_cursor": {
                        "type": "object",
                        "description": "Treasury token-account cursor returned by the previous call."
                    },
                    "observed_at_ts": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Current Unix timestamp supplied by the SOP runtime."
                    }
                },
                "required": ["previous_snapshot", "native_cursor", "token_cursor", "observed_at_ts"],
                "additionalProperties": false
            })
            .to_string()
        }

        fn execute(args: String) -> Result<ToolResult, String> {
            let parsed: ExecuteArgs = match serde_json::from_str(&args) {
                Ok(value) => value,
                Err(error) => return failure(format!("invalid arguments: {error}")),
            };
            let config = match WatchConfig::from_section(&parsed.config) {
                Ok(value) => value,
                Err(error) => return failure(error.to_string()),
            };
            let request = WatchArgs {
                previous_snapshot: parsed.previous_snapshot,
                native_cursor: parsed.native_cursor,
                token_cursor: parsed.token_cursor,
            };
            match execute_watch(&WakiTransport, &config, &request, parsed.observed_at_ts) {
                Ok(output) => {
                    emit(
                        PluginAction::Complete,
                        PluginOutcome::Success,
                        "treasury watch completed",
                    );
                    Ok(ToolResult {
                        success: true,
                        output: serde_json::to_string(&output)
                            .map_err(|error| format!("serialize output: {error}"))?,
                        error: None,
                    })
                }
                Err(error) => failure(error.to_string()),
            }
        }
    }

    fn failure(message: String) -> Result<ToolResult, String> {
        emit(
            PluginAction::Fail,
            PluginOutcome::Failure,
            "treasury watch failed closed",
        );
        Ok(ToolResult {
            success: false,
            output: String::new(),
            error: Some(message),
        })
    }

    fn emit(action: PluginAction, outcome: PluginOutcome, message: &str) {
        log_record(
            LogLevel::Info,
            &PluginEvent {
                function_name: "safespend_treasury_watch::tool::execute".to_string(),
                action,
                outcome: Some(outcome),
                duration_ms: None,
                attrs: None,
                message: message.to_string(),
            },
        );
    }

    export!(TreasuryWatch);
}
