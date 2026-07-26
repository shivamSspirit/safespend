use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BalanceSnapshot {
    pub finalized_slot: u64,
    pub observed_at_ts: u64,
    pub token_balance_base_units: u64,
    pub sol_balance_lamports: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AlertCode {
    TokenBalanceChanged,
    SolBalanceChanged,
    LowTokenReserve,
    LowSolReserve,
    RunwayFloorBreached,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Alert {
    pub code: AlertCode,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TreasurySummary {
    pub finalized_slot: u64,
    pub token_balance_base_units: u64,
    pub sol_balance_lamports: u64,
    pub token_delta_base_units: i128,
    pub sol_delta_lamports: i128,
    pub runway_milliweeks: Option<u128>,
    pub alerts: Vec<Alert>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TreasuryThresholds {
    pub weekly_burn_base_units: u64,
    pub minimum_runway_weeks: u64,
    pub minimum_token_reserve_base_units: u64,
    pub minimum_sol_reserve_lamports: u64,
    pub meaningful_token_delta_base_units: u64,
    pub meaningful_sol_delta_lamports: u64,
}

pub fn summarize_treasury(
    previous: Option<&BalanceSnapshot>,
    current: &BalanceSnapshot,
    thresholds: &TreasuryThresholds,
) -> TreasurySummary {
    let (token_delta, sol_delta) = match previous {
        Some(prior) => (
            i128::from(current.token_balance_base_units)
                - i128::from(prior.token_balance_base_units),
            i128::from(current.sol_balance_lamports) - i128::from(prior.sol_balance_lamports),
        ),
        None => (0, 0),
    };

    let mut alerts = Vec::new();
    if previous.is_some()
        && token_delta.unsigned_abs() >= u128::from(thresholds.meaningful_token_delta_base_units)
    {
        alerts.push(Alert {
            code: AlertCode::TokenBalanceChanged,
            message: format!("treasury token balance changed by {token_delta} base units"),
        });
    }
    if previous.is_some()
        && sol_delta.unsigned_abs() >= u128::from(thresholds.meaningful_sol_delta_lamports)
    {
        alerts.push(Alert {
            code: AlertCode::SolBalanceChanged,
            message: format!("treasury SOL balance changed by {sol_delta} lamports"),
        });
    }
    if current.token_balance_base_units < thresholds.minimum_token_reserve_base_units {
        alerts.push(Alert {
            code: AlertCode::LowTokenReserve,
            message: "treasury token balance is below the protected reserve".into(),
        });
    }
    if current.sol_balance_lamports < thresholds.minimum_sol_reserve_lamports {
        alerts.push(Alert {
            code: AlertCode::LowSolReserve,
            message: "treasury SOL balance is below the operational reserve".into(),
        });
    }
    if thresholds.weekly_burn_base_units != 0
        && u128::from(current.token_balance_base_units)
            < u128::from(thresholds.weekly_burn_base_units)
                * u128::from(thresholds.minimum_runway_weeks)
    {
        alerts.push(Alert {
            code: AlertCode::RunwayFloorBreached,
            message: format!(
                "treasury runway is below the protected {minimum_runway_weeks}-week floor",
                minimum_runway_weeks = thresholds.minimum_runway_weeks
            ),
        });
    }

    let runway_milliweeks = runway_milliweeks(
        current.token_balance_base_units,
        thresholds.weekly_burn_base_units,
    );

    TreasurySummary {
        finalized_slot: current.finalized_slot,
        token_balance_base_units: current.token_balance_base_units,
        sol_balance_lamports: current.sol_balance_lamports,
        token_delta_base_units: token_delta,
        sol_delta_lamports: sol_delta,
        runway_milliweeks,
        alerts,
    }
}

pub fn runway_milliweeks(
    token_balance_base_units: u64,
    weekly_burn_base_units: u64,
) -> Option<u128> {
    if weekly_burn_base_units == 0 {
        return None;
    }
    Some(u128::from(token_balance_base_units) * 1_000 / u128::from(weekly_burn_base_units))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(token: u64, sol: u64) -> BalanceSnapshot {
        BalanceSnapshot {
            finalized_slot: 42,
            observed_at_ts: 1_780_000_000,
            token_balance_base_units: token,
            sol_balance_lamports: sol,
        }
    }

    fn thresholds(
        weekly_burn_base_units: u64,
        minimum_runway_weeks: u64,
        minimum_token_reserve_base_units: u64,
        minimum_sol_reserve_lamports: u64,
        meaningful_token_delta_base_units: u64,
        meaningful_sol_delta_lamports: u64,
    ) -> TreasuryThresholds {
        TreasuryThresholds {
            weekly_burn_base_units,
            minimum_runway_weeks,
            minimum_token_reserve_base_units,
            minimum_sol_reserve_lamports,
            meaningful_token_delta_base_units,
            meaningful_sol_delta_lamports,
        }
    }

    #[test]
    fn computes_exact_runway_without_floats() {
        let summary = summarize_treasury(
            None,
            &snapshot(2_450_000_000, 2_000_000_000),
            &thresholds(
                310_000_000,
                0,
                500_000_000,
                10_000_000,
                1_000_000,
                1_000_000,
            ),
        );
        assert_eq!(summary.runway_milliweeks, Some(7_903));
        assert!(summary.alerts.is_empty());
    }

    #[test]
    fn emits_only_meaningful_deltas() {
        let previous = snapshot(100_000_000, 20_000_000);
        let current = snapshot(99_000_001, 19_500_001);
        let summary = summarize_treasury(
            Some(&previous),
            &current,
            &thresholds(10_000_000, 0, 50_000_000, 10_000_000, 1_000_000, 500_000),
        );
        assert!(summary.alerts.is_empty());
    }

    #[test]
    fn alerts_on_outflow_and_low_reserves() {
        let previous = snapshot(100_000_000, 20_000_000);
        let current = snapshot(40_000_000, 5_000_000);
        let summary = summarize_treasury(
            Some(&previous),
            &current,
            &thresholds(10_000_000, 0, 50_000_000, 10_000_000, 1_000_000, 500_000),
        );
        assert_eq!(summary.alerts.len(), 4);
        assert_eq!(summary.token_delta_base_units, -60_000_000);
        assert_eq!(summary.sol_delta_lamports, -15_000_000);
    }

    #[test]
    fn zero_burn_reports_unknown_runway() {
        let summary = summarize_treasury(None, &snapshot(100, 100), &thresholds(0, 0, 0, 0, 1, 1));
        assert_eq!(summary.runway_milliweeks, None);
    }

    #[test]
    fn alerts_below_runway_floor_without_float_math() {
        let summary = summarize_treasury(
            None,
            &snapshot(79_999_999, 20_000_000),
            &thresholds(10_000_000, 8, 50_000_000, 10_000_000, 1_000_000, 1_000_000),
        );
        assert_eq!(summary.runway_milliweeks, Some(7_999));
        assert!(summary
            .alerts
            .iter()
            .any(|alert| alert.code == AlertCode::RunwayFloorBreached));
    }

    #[test]
    fn computes_large_runway_without_overflow() {
        assert_eq!(
            runway_milliweeks(u64::MAX, 1),
            Some(u128::from(u64::MAX) * 1_000)
        );
    }
}
