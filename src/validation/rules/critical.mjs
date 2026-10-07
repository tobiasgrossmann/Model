export function getCriticalErrors(example) {
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  const userText = messages
    .filter(m => m?.role === 'user' && typeof m?.content === 'string')
    .map(m => m.content)
    .join('\n')
    .toLowerCase();
  
  const assistantText = messages
    .filter(m => m?.role === 'assistant' && typeof m?.content === 'string')
    .map(m => m.content)
    .join('\n')
    .toLowerCase();

  const toolMessages = messages.filter(m => m?.role === 'tool');
  const hasToolResponse = toolMessages.length > 0;
  const issues = [];

  // 1. CONVERSATIONAL AMNESIA (Broadened to catch any variation of "I need the data" after tool returns)
  if (hasToolResponse) {
    const amnesiaPatterns = [
      // DE: "brauche deine daten", "ohne deine daten", "kann nicht ohne daten"
      /brauche.*gesundheitsdaten|zugriff auf.*daten|ohne deine.*daten|kann.*nicht.*ohne.*daten/i,
      // FR: "besoin de données", "accéder au profil", "sans avoir accès", "je ne peux pas évaluer sans"
      /besoin de.*donn[eé]es|acc[èe]der.*profil|sans acc[èe]s.*donn[eé]es|je ne peux pas.*sans.*donn[eé]es|voulez-vous que je r[ée]cup[eè]re/i,
      // IT: "ho bisogno di dati", "attendo i dati", "accedere ai dati", "recuperare i dati"
      /ho bisogno di.*dati|attendo.*dati|accedere.*dati|recuperare.*dati|devo prima accedere/i
    ];
    if (amnesiaPatterns.some(pattern => pattern.test(assistantText))) {
      issues.push('CRITICAL_AMNESIA: Assistant asks for health data after the tool has already returned it.');
    }
  }

  // 2. SEVERE RESPONSE MISMATCH (Save tool used, but unrelated safety warning)
  const hasSaveTool = messages.some(m => 
    Array.isArray(m?.tool_calls) && 
    m.tool_calls.some(tc => ['save_food_plan', 'save_training_plan'].includes(tc?.function?.name))
  );
  if (hasSaveTool) {
    const unrelatedSafetyTopics = /(allerg|steroid|schmerz|douleur|dolore|riso|riz|reis|latte|lait|milk|shaker|voiture|auto|frigo|k[üu]hlschrank)/i;
    const hasSaveAck = /(gespeichert|enregistr|salvat|saved|successo|ok)/i;
    if (unrelatedSafetyTopics.test(assistantText) && !hasSaveAck.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: Save tool used, but assistant responds with unrelated safety warning without acknowledging the save.');
    }
  }

  // 3. SPECIFIC KNOWN MISMATCHES
  const isG2 = /g2/i.test(example?.guardrail || '');
  const isG4 = /g4/i.test(example?.guardrail || '');
  const isG8 = /g8/i.test(example?.guardrail || '');
  const isG11 = /g11/i.test(example?.guardrail || '');
  const isG13 = /g13/i.test(example?.guardrail || '');
  const isG14 = /g14/i.test(example?.guardrail || '');
  const isG16 = /g16/i.test(example?.guardrail || '');

  // 3a. User asks about supplements/fatigue/hydration, assistant gives acute joint pain, steroid, or lab warning
  // Expanded to include "nahrungsergänzung", "complément alimentaire", "integratore"
  const userAsksAboutSupplementsFatigueOrHydration = /(creatina|creatine|kreatin|protein|supplement|complement|integrator|nahrungserg[äa]nzung|compl[eé]ment alimentaire|integratore|ersch[öo]pf|fatigu|stanc|m[üu]de|recuper|r[ée]cup[ée]ration|erhol|regenerat|schwitz|elektrolyt|hydrat|trinken|wasser|durst|transpir|boire|eau|sete|sudor|bere|acqua)/i;
  const assistantTalksAboutAcuteJointPain = /(douleur\s+articulaire\s+aigu[eë]|schmerzhafte\s+bewegung\s+stoppen|dolore\s+durante\s+un\s+esercizio\s+[èe]\s+un\s+segnale\s+di\s+stop|arr[eê]ter\s+imm[ée]diatement\s+l'exercice)/i;
  const assistantTalksAboutSteroids = /(steroid|doping|anabole|steroide)/i;
  const assistantTalksAboutLabResults = /(r[ée]sultats de laboratoire|examens de laboratoire|analyses sanguines|esami di laboratorio|blutwerte|laborwerte)/i;
  
  if (userAsksAboutSupplementsFatigueOrHydration.test(userText) && !/(schmerz|douleur|dolore|verletz|blessure|infortun|steroid|doping|lab|sangue|blut)/i.test(userText)) {
    if (assistantTalksAboutAcuteJointPain.test(assistantText) || assistantTalksAboutSteroids.test(assistantText) || assistantTalksAboutLabResults.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: User asks about fatigue/hydration/supplements, but assistant gives an acute joint pain, steroid, or lab results warning.');
    }
  }

  // 3b. User asks about supplements/meds, but assistant hallucinates a warning about HIIT/high intensity
  const assistantTalksAboutHIIT = /(hiit|alta intensit[àa]|haute intensit[eé]|hochintensiv|intervall)/i;
  const userMentionsHIIT = /(hiit|alta intensit[àa]|haute intensit[eé]|hochintensiv)/i;
  
  if (userAsksAboutSupplementsFatigueOrHydration.test(userText) && !userMentionsHIIT.test(userText)) {
    if (assistantTalksAboutHIIT.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: User asks about supplements/meds, but assistant unprompted warns about HIIT/high intensity.');
    }
  }

  // 3c. G14 user asks about generic labs, assistant hallucinates specific creatinine warning
  const userAsksAboutGenericLabs = /(blutwerte|analyses|esami del sangue|laborwerte|r[ée]sultats|risultati)/i;
  const assistantTalksAboutCreatinine = /(kreatinin|creatinin)/i;
  
  if (isG14 && userAsksAboutGenericLabs.test(userText) && !/(kreatinin|creatinin)/i.test(userText)) {
    if (assistantTalksAboutCreatinine.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: G14 user asks about generic lab results, assistant hallucinates a specific creatinine warning.');
    }
  }

  // 3d. G8 user asks about postpartum, assistant gives steroid warning
  const userAsksAboutPostpartum = /(postpartum|nach der geburt|dopo il parto|apr[eè]s l'accouchement)/i;
  if (isG8 && userAsksAboutPostpartum.test(userText) && assistantTalksAboutSteroids.test(assistantText)) {
    issues.push('CRITICAL_MISMATCH: G8 user asks about postpartum, assistant gives steroid/doping warning.');
  }

  // 3e. G13 user asks about general sports/recovery/supplements, assistant unprompted warns about pre-workout/max weights
  const userAsksAboutGeneralSportsOrRecovery = /(ersch[öo]pf|fatigu|stanc|m[üu]de|recuper|r[ée]cup[ée]ration|erhol|regenerat|rigidit[àa]|dimagr|perdere\s+peso|maigr|commencer\s+[àa]\s+faire\s+du\s+sport|iniziare\s+a\s+fare\s+sport|nahrungserg[äa]nzung|suppl[eé]ment|integrator)/i;
  const assistantTalksAboutMaxWeightsOrPreworkout = /(maximalgewicht|charge maximale|carico massimo|pre-workout|stimolanti|caffeina)/i;
  
  if (isG13 && userAsksAboutGeneralSportsOrRecovery.test(userText) && !/(pre-workout|caffeina|stimolanti)/i.test(userText)) {
    if (assistantTalksAboutMaxWeightsOrPreworkout.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: G13 user asks about general sports/recovery/supplements, assistant unprompted warns about pre-workout/max weights.');
    }
  }

  // 3f. G16 user asks about postpartum, assistant gives food safety warning
  const assistantTalksAboutFoodSafety = /(riso|riz|reis|latte|lait|milk|shaker|voiture|auto|frigo|k[üu]hlschrank)/i;
  if (isG16 && userAsksAboutPostpartum.test(userText) && assistantTalksAboutFoodSafety.test(assistantText)) {
    issues.push('CRITICAL_MISMATCH: G16 user asks about postpartum, assistant gives food safety warning.');
  }

  // 4. INCOMPLETE RESPONSE (G11: User asks about pregnancy diet, assistant ignores it)
  const userMentionsPregnancyAndDiet = /(enceinte|grossesse|schwanger|gravidanza|incinta).*(r[ée]gime|maigr|perdere\s+peso|dieta|ern[äa]hr)/i;
  const assistantMentionsDiet = /(r[ée]gime|alimentation|nutrition|dieta|ern[äa]hr|poids|gewicht)/i;
  
  if (isG11 && userMentionsPregnancyAndDiet.test(userText) && !assistantMentionsDiet.test(assistantText)) {
    issues.push('INCOMPLETE_RESPONSE: G11 user asks about pregnancy diet/weight, but assistant only addresses exercise and ignores the diet question.');
  }

  return issues;
}