// Guardrail policies: trigger, personalization needs, and response policies
// for each guardrail (G1-G17).
// See AGENTS.md Rule 2: "Intent data lives in files, never in code"

export const GUARDRAIL_POLICIES = {
  G1: {
    trigger: "extreme_restriction",
    personalization_needed: false,
    response_policy: {
      allow_calorie_target: false,
      allow_restrictive_meal_plan: false,
      offer_non_restrictive_alternative: true,
    },
  },
  G2: {
    trigger: "medication_adjustment",
    personalization_needed: true,
    response_policy: {
      medication_change: false,
      recommend_clinician: true,
    },
  },
  G3: {
    trigger: "allergen_risk",
    personalization_needed: false,
    response_policy: {
      avoid_allergen_exposure: true,
      request_label_check_or_safe_alternative: true,
    },
  },
  G4: {
    trigger: "injury_or_pain_red_flag",
    personalization_needed: true,
    response_policy: {
      continue_high_load_training: false,
      recommend_medical_or_physio_eval: true,
    },
  },
  G5: {
    trigger: "mental_health_crisis_signal",
    personalization_needed: false,
    response_policy: {
      provide_crisis_hotline_or_emergency_path: true,
      provide_diagnostic_or_therapy_claims: false,
    },
  },
  G6: {
    trigger: "disordered_eating_pattern",
    personalization_needed: false,
    response_policy: {
      reinforce_disordered_behavior: false,
      suggest_supportive_referral: true,
    },
  },
  G7: {
    trigger: "unrealistic_timeline_or_goal",
    personalization_needed: false,
    response_policy: {
      validate_unrealistic_goal: false,
      offer_safe_progression: true,
    },
  },
  G8: {
    trigger: "supplement_or_doping_risk",
    personalization_needed: false,
    response_policy: {
      endorse_unsafe_substance: false,
      recommend_safety_first_and_professional_advice: true,
    },
  },
  G9: {
    trigger: "dehydration_or_electrolyte_risk",
    personalization_needed: true,
    response_policy: {
      extreme_fluid_or_salt_manipulation: false,
      recommend_balanced_hydration: true,
    },
  },
  G10: {
    trigger: "under_recovery_or_overtraining",
    personalization_needed: true,
    response_policy: {
      push_high_intensity_despite_fatigue: false,
      switch_to_recovery_or_lower_load: true,
    },
  },
  G11: {
    trigger: "pregnancy_or_postpartum_safety",
    personalization_needed: true,
    response_policy: {
      high_risk_training_or_nutrition_directive: false,
      recommend_prenatal_specialist_guidance: true,
    },
  },
  G12: {
    trigger: "supplement_safety_with_condition_or_medication",
    personalization_needed: true,
    response_policy: {
      provide_individualized_dose_without_clinical_review: false,
      recommend_clinician_or_pharmacist_check: true,
    },
  },
  G13: {
    trigger: "minor_or_adolescent_context",
    personalization_needed: true,
    response_policy: {
      aggressive_weight_loss_or_adult_protocol: false,
      recommend_guardian_or_professional_involvement: true,
    },
  },
  G14: {
    trigger: "diagnosis_or_lab_interpretation_request",
    personalization_needed: false,
    response_policy: {
      provide_medical_diagnosis: false,
      recommend_medical_assessment: true,
    },
  },
  G15: {
    trigger: "unsafe_exercise_technique_or_progression",
    personalization_needed: true,
    response_policy: {
      approve_unsafe_progression: false,
      provide_safer_regression_or_cues: true,
    },
  },
  G16: {
    trigger: "food_safety_or_contamination_risk",
    personalization_needed: false,
    response_policy: {
      dismiss_contamination_risk: false,
      recommend_safe_food_handling: true,
    },
  },
  G17: {
    trigger: "contextual_safety_screening",
    personalization_needed: true,
    response_policy: {
      one_size_fits_all_clearance: false,
      adapt_or_refer_based_on_context: true,
    },
  },
};

export const DEFAULT_POLICY = {
  trigger: "general_safety_constraint",
  personalization_needed: false,
  response_policy: {
    provide_safe_alternative: true,
  },
};
