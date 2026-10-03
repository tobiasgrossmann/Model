import { getAllowedToolNames } from '../toolSpecs.mjs';

function extractText(example) {
  return (example?.messages || [])
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n');
}

function extractToolMetrics(example) {
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  for (const message of messages) {
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const payload = JSON.parse(message.content);
      if (payload && typeof payload === 'object') {
        const height = Number(payload.height_cm ?? payload.height ?? payload['height_cm'] ?? payload['height']);
        const weight = Number(payload.weight_kg ?? payload.weight ?? payload['weight_kg'] ?? payload['weight']);
        const age = Number(payload.age ?? payload['age']);
        if ([height, weight, age].some((value) => Number.isFinite(value))) {
          return {
            height: Number.isFinite(height) ? height : null,
            weight: Number.isFinite(weight) ? weight : null,
            age: Number.isFinite(age) ? age : null,
          };
        }
      }
    } catch {
      // fall through to text extraction
    }
  }
  return null;
}

function extractAnthropometrics(text, example = null) {
  const normalized = String(text || '');
  const toolMetrics = example ? extractToolMetrics(example) : null;
  if (toolMetrics && (toolMetrics.height != null || toolMetrics.weight != null || toolMetrics.age != null)) {
    return toolMetrics;
  }

  const heightMatch = normalized.match(/(?:height[_ -]?cm|größe|taille|altezza|h(?:ö|o)he)[^\n]{0,20}(\d{2,3})(?:\s*(?:cm|cm\b))/i)
    || normalized.match(/(\d{2,3})\s*(?:cm|cm\b)/i);

  const weightMatch = normalized.match(/(?:weight[_ -]?kg|gewicht|poids|peso)[^\n]{0,20}(\d{2,3}(?:[.,]\d+)?)(?:\s*(?:kg|kilo|kg\b))/i)
    || normalized.match(/(\d{2,3}(?:[.,]\d+)?)(?:\s*(?:kg|kilo|kg\b))/i);

  const ageMatch = normalized.match(/(?:age|alter|âge|età)[^\n]{0,20}(\d{1,3})/i);

  const height = heightMatch ? Number(String(heightMatch[1]).replace(',', '.')) : null;
  const weight = weightMatch ? Number(String(weightMatch[1]).replace(',', '.')) : null;
  const age = ageMatch ? Number(ageMatch[1]) : null;

  return { height, weight, age };
}

function extractExplicitBmiClaim(text) {
  const match = String(text || '').match(/(?:BMI|IMC)[^\d]{0,20}(\d{1,2}(?:[.,]\d+)?)/i);
  return match ? Number(match[1].replace(',', '.')) : null;
}

function extractThresholdClaim(text) {
  const normalized = String(text || '');
  const patterns = [
    /(?:IMC|BMI)[^\n]{0,40}(?:sup(?:é|e)rieur|higher|above|strictement sup(?:é|e)rieur|au-dessus).*?(?:35|36|37|38|39|40)/i,
    /(?:35|36|37|38|39|40)[^\n]{0,30}(?:IMC|BMI)/i,
    /(?:IMC|BMI)\s+(?:de|=|\>)\s*(?:35|36|37|38|39|40)/i,
  ];

  for (const pattern of patterns) {
    if (pattern.test(normalized)) return true;
  }

  return false;
}

export const bmiRule = {
  id: 'bmi',
  validate(example) {
    const issues = [];
    const text = extractText(example);
    const allowedTools = new Set(getAllowedToolNames());
    const dims = extractAnthropometrics(text, example);

    if (dims.height == null || dims.weight == null) {
      return issues;
    }

    const actualBmi = dims.weight / ((dims.height / 100) ** 2);
    const claimedBmi = extractExplicitBmiClaim(text);

    const assistant = (example?.messages || [])
      .filter((message) => message?.role === 'assistant' && typeof message?.content === 'string')
      .map((message) => message.content)
      .join('\n');

    if (claimedBmi != null && Math.abs(claimedBmi - actualBmi) > 0.3) {
      issues.push(`BMI-Rechenfehler: Behauptet ${claimedBmi}, berechnet ${actualBmi.toFixed(1)}`);
    }

    if (extractThresholdClaim(assistant || text) && actualBmi < 35 && Math.abs(actualBmi - 35) > 0.3) {
      issues.push(`BMI threshold mismatch: assistant claims threshold >35 but computed BMI is ${actualBmi.toFixed(2)}`);
    }

    const hasBmiMention = /\b(?:BMI|IMC)\b/i.test(assistant);
    const hasWeightSafety = /(gewicht|poids|peso|taille|altezza|gr(?:ö|o)sse).{0,80}(gef(?:ä|a)hr|risque|pericolo|unsafe|zu wenig|trop peu|troppo poco|nicht geeignet|inadatt|non adatto)/i.test(assistant);
    const hasHealthTool = (example?.messages || []).some((message) =>
      Array.isArray(message?.tool_calls) &&
      message.tool_calls.some((toolCall) => {
        const name = toolCall?.function?.name || toolCall?.name;
        return name === 'get_user_health_data' || (typeof name === 'string' && allowedTools.has(name) && /health|metrics|profile/i.test(name));
      })
    );

    if ((hasBmiMention || hasWeightSafety) && !hasHealthTool) {
      issues.push('BMI/weight-dependent safety reasoning without prior get_user_health_data call');
    }

    return issues;
  },
};
