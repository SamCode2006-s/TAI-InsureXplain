# InsureXplain — Global Model and Fairness Review

## Executive summary
This educational prototype predicts whether a motor policy recorded at least one claim.
It does not predict actual underwriting approval or denial and is not production-ready.

## Dataset
- Source file: freMTPL2freq.csv
- Rows after basic cleaning: 678,013
- Features used: 10
- Target: ClaimOccurred = 1 when ClaimNb > 0, otherwise 0.
- ClaimNb and IDpol are excluded from model features.
- Exposure represents the fraction of a year observed and should be considered carefully in actuarial modelling.

## Selected model
- Model: Random Forest
- Accuracy: 0.9254
- Balanced accuracy: 0.5564
- Precision: 0.1881
- Recall: 0.1462
- F1: 0.1645
- ROC-AUC: 0.6895

## Global SHAP findings
Top features by mean absolute SHAP contribution:
- num__Exposure: mean absolute SHAP = 0.07732
- num__VehAge: mean absolute SHAP = 0.04988
- num__Density: mean absolute SHAP = 0.03906
- num__DrivAge: mean absolute SHAP = 0.03886
- num__BonusMalus: mean absolute SHAP = 0.03810
- num__VehPower: mean absolute SHAP = 0.02148
- cat__VehBrand_B12: mean absolute SHAP = 0.01076
- cat__Region_R24: mean absolute SHAP = 0.00742
- cat__VehGas_Diesel: mean absolute SHAP = 0.00676
- cat__VehGas_Regular: mean absolute SHAP = 0.00645

SHAP values describe how the fitted model output is attributed among features; they do not establish causation.

## Fairness diagnostics
Group-wise performance tables were exported for driver-age bands, area, and region. Compare predicted-positive rates, recall/TPR, FPR, FNR, and sample sizes. Differences are diagnostic signals requiring context and further investigation, not standalone legal conclusions.

## Potential risks
- Age and geographic variables may act as sensitive or proxy variables depending on the jurisdiction and insurance product.
- Correlation with a sensitive attribute does not by itself establish unlawful discrimination.
- Small groups and missing protected attributes limit conclusions.
- Claim occurrence is not the same target as underwriting approval, claim severity, or fraud.

## Recommendations
1. Validate calibration and performance on a temporally separate and representative dataset.
2. Consult actuaries and legal/compliance specialists before any real pricing or underwriting use.
3. Evaluate applicable jurisdiction-specific restrictions on rating variables.
4. Review group-level errors and potential proxy features; document mitigation decisions.
5. Keep human review and a transparent customer communication process.

## Limitations
This is a student prototype. It does not certify regulatory compliance, establish causal explanations, or authorize automated adverse decisions.
