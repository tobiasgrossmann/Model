// rules/critical.mjs

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

  // 1. CONVERSATIONAL AMNESIA
  if (hasToolResponse) {
    const amnesiaPatterns = [
      /ben[öo]tige.*gesundheitsdaten|zugriff auf deine daten|abrufen darf|ohne deine (aktuellen|gespeicherten) gesundheitsdaten/i,
      /besoin de (vos|tes) donn[eé]es de sant[eé]|acc[èe]der [àa] vos donn[eé]es|veuillez (fournir|autoriser)|sans acc[èe]der [àa] vos donn[eé]es|je ne peux pas [eé]valuer.*sans acc[èe]der/i,
      /ho bisogno di accedere ai tuoi dati sanitari|attendo il (risultato|esito|completamento)|permettimi di recuperare|senza prima accedere ai tuoi dati/i
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
  const isG13 = /g13/i.test(example?.guardrail || '');
  const isG14 = /g14/i.test(example?.guardrail || '');
  const isG16 = /g16/i.test(example?.guardrail || '');

  const userAsksAboutSupplementsOrFatigue = /(creatina|creatine|kreatin|protein|supplement|complement|integrator|ersch[öo]pf|fatigu|stanc|m[üu]de|recuper|r[ée]cup[ée]ration|erholung)/i;
  const assistantTalksAboutAcuteJointPain = /(douleur\s+articulaire\s+aigu[eë]|schmerzhafte\s+bewegung\s+stoppen|dolore\s+durante\s+un\s+esercizio\s+[èe]\s+un\s+segnale\s+di\s+stop|arr[eê]ter\s+imm[ée]diatement\s+l'exercice)/i;
  
  if (userAsksAboutSupplementsOrFatigue.test(userText) && !/(schmerz|douleur|dolore|verletz|blessure|infortun)/i.test(userText)) {
    if (assistantTalksAboutAcuteJointPain.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: User asks about supplements/fatigue, but assistant gives an acute joint pain warning.');
    }
  }

  const userAsksAboutFatigueRecovery = /(ersch[öo]pf|fatigu|stanc|m[üu]de|recuper|r[ée]cup[ée]ration|erholung|rigidit[àa])/i;
  const assistantTalksAboutMaxWeightsOrPreworkout = /(maximalgewicht|charge maximale|carico massimo|pre-workout|stimolanti|caffeina)/i;
  
  if (isG13 && userAsksAboutFatigueRecovery.test(userText) && !/(pre-workout|caffeina|stimolanti)/i.test(userText)) {
    if (assistantTalksAboutMaxWeightsOrPreworkout.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: G13 user asks about fatigue, assistant unprompted warns about pre-workout/max weights.');
    }
  }

  const userAsksAboutSpecificLab = /(cholesterol|ldl|ferritin|entz[üu]nd|tiroide|thyroid)/i;
  const assistantTalksAboutCreatinine = /(kreatinin|creatinin)/i;
  
  if (isG14 && userAsksAboutSpecificLab.test(userText) && !/(kreatinin|creatinin|protein)/i.test(userText)) {
    if (assistantTalksAboutCreatinine.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: G14 user asks about specific lab results, assistant gives generic creatinine/protein warning.');
    }
  }

  const userAsksAboutPostpartum = /(postpartum|nach der geburt|dopo il parto|apr[eè]s l'accouchement)/i;
  const assistantTalksAboutFoodSafety = /(riso|riz|reis|latte|lait|milk|shaker|voiture|auto|frigo|k[üu]hlschrank)/i;

  if (isG16 && userAsksAboutPostpartum.test(userText)) {
    if (assistantTalksAboutFoodSafety.test(assistantText)) {
      issues.push('CRITICAL_MISMATCH: G16 user asks about postpartum, assistant gives food safety warning.');
    }
  }

  return issues;
}