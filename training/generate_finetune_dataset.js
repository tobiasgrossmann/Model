#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_DIR = path.join(PROJECT_ROOT, 'knowledge');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'training', 'generated', `finetune_${Date.now()}.jsonl`);
const LOCALES = ['de', 'fr', 'it'];

function parseArgs(argv) {
  const args = {
    total: 5000,
    output: null,
    dryRun: false,
    guardrail: null,
    tasks: 'all',
    qualityCheck: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--total') args.total = Number(argv[++i]);
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--guardrail') args.guardrail = argv[++i];
    else if (arg === '--tasks') args.tasks = argv[++i];
    else if (arg === '--quality-check') args.qualityCheck = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.total) || args.total <= 0) {
    throw new Error('Need --total with a positive integer value.');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node generate_finetune_dataset.js [options]

Options:
  --total N             Total number of records to generate (default: 5000)
  --output PATH         Write output file (.json or .jsonl)
  --guardrail G3        Restrict generation to a single guardrail ID
  --tasks all|guardrails|tooling
  --quality-check       Validate generated records before finishing
  --dry-run             Print the generation plan without writing files
  --help                Show this help

Examples:
  node training/generate_finetune_dataset.js --total 5000 --output training/generated/fitness_dataset.json
  node training/generate_finetune_dataset.js --guardrail G3 --total 200
  node training/generate_finetune_dataset.js --tasks guardrails --total 1000 --dry-run
`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildTaskPlan(guardrails, totalCount, taskScope) {
  const tasks = [];
  const guardrailEntries = guardrails.guardrails || [];

  for (const item of guardrailEntries) {
    tasks.push({
      kind: 'guardrail',
      id: item.id,
      name: item.name,
      description: item.hard_when_text || item.name,
    });
  }

  tasks.push({ kind: 'ordinary', id: 'ordinary', name: 'ordinary conversation' });
  tasks.push({ kind: 'tooling', id: 'tooling', name: 'tooling / health data' });

  let filteredTasks = tasks;
  if (taskScope === 'guardrails') {
    filteredTasks = tasks.filter((task) => task.kind === 'guardrail');
  } else if (taskScope === 'tooling') {
    filteredTasks = tasks.filter((task) => task.kind === 'tooling' || task.kind === 'ordinary');
  }

  const plan = [];
  const base = Math.floor(totalCount / filteredTasks.length);
  const remainder = totalCount % filteredTasks.length;

  for (let i = 0; i < filteredTasks.length; i += 1) {
    const task = filteredTasks[i];
    const target = base + (i < remainder ? 1 : 0);
    plan.push({ ...task, target });
  }

  return plan;
}

const POLICY_RULES = {
  safe_pace_kg_per_week: {
    standard: 0.75,
    with_conditions: 0.5,
    high_stress_or_low_readiness: 0.35,
    pregnancy: 0,
  },
  calorie_floor_kcal: {
    men: 1500,
    women_or_unknown: 1200,
  },
  bmi_floor: 20,
};

const PROHIBITED_PROFILE_PATTERNS = [
  /saved.*profile/i,
  /added.*profile/i,
  /stored.*profile/i,
  /updated.*profile/i,
  /permanent.*profile/i,
  /persist.*profile/i,
  /result.*saved/i,
];

const CASE_LIBRARY = {
  G1: {
    de: [
      {
        comment: 'Hard profile: BMI 17.1 below healthy minimum; no unsafe low-calorie plan.',
        messages: [
          { role: 'user', content: 'Ich wiege 52 kg und will in 2 Wochen 2 kg abnehmen. Was ist der sichere Weg?' },
          { role: 'assistant', content: 'Bei deinem Gewicht und deiner Körpergrösse liegt dein BMI bei 17,1. Ich würde kein 800-kcal-Defizit empfehlen; das wäre unter der sicheren Untergrenze und für dich nicht passend.' },
          { role: 'user', content: 'Was würdest du stattdessen empfehlen?' },
          { role: 'assistant', content: 'Ich würde einen stabilen, nährstoffreichen Plan mit regelmäßigen Mahlzeiten, leichter Bewegung und Recovery empfehlen — kein aggressiver Kaloriencut.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Profil dur: BMI 17,1 sous le minimum sain; refus du plan trop bas.',
        messages: [
          { role: 'user', content: 'Je pèse 52 kg et je veux perdre 2 kg en 2 semaines. Quel est le plan le plus sûr ?' },
          { role: 'assistant', content: 'Avec ton poids et ta taille, ton IMC est d’environ 17,1. Je ne recommanderais pas un plan à 800 kcal; il est en dessous du seuil sûr et n’est pas adapté.' },
          { role: 'user', content: 'Que ferais-tu à la place ?' },
          { role: 'assistant', content: 'Je te proposerais un plan stable, riche en nutriments, avec repas réguliers et activité légère plutôt qu’un déficit trop sévère.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Profilo rigido: BMI 17,1 sotto il minimo sano; nessun piano calorico troppo basso.',
        messages: [
          { role: 'user', content: 'Peso 52 kg e voglio perdere 2 kg in 2 settimane. Qual è il modo più sicuro?' },
          { role: 'assistant', content: 'Con il tuo peso e la tua altezza, il tuo BMI è circa 17,1. Non consiglierei un piano a 800 kcal; è sotto la soglia sicura e non è adatto a te.' },
          { role: 'user', content: 'Che cosa faresti invece?' },
          { role: 'assistant', content: 'Ti proporrei un piano stabile, nutriente, con pasti regolari, movimento leggero e recupero, non un calo calorico aggressivo.' },
        ],
      },
    ],
  },
  G2: {
    de: [
      {
        comment: 'Medical advice guardrail: profile shows medication context; no dosage recommendation.',
        messages: [
          { role: 'user', content: 'Ich nehme Blutdruckmedikamente und will ein Fatburner-Produkt starten. Ist das okay?' },
          { role: 'assistant', content: 'Ich kann keine Dosierung oder medizinische Empfehlung geben. Bei deinem Medikamenten-Kontext ist das eine Fachfrage für Arzt oder Apotheke.' },
          { role: 'user', content: 'Kannst du mir wenigstens sagen, ob die Kombination grundsätzlich gefährlich ist?' },
          { role: 'assistant', content: 'Ich kann keine sichere Aussage über Wechselwirkungen treffen. Das ist genau der Fall, wo Ärzte oder Apotheker die richtige Einschätzung geben sollten.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Gardien médical: contexte médicamenteux connu; pas de dosage.',
        messages: [
          { role: 'user', content: 'Je prends un traitement pour la tension et je veux commencer un brûleur de graisse. Est-ce acceptable ?' },
          { role: 'assistant', content: 'Je ne peux pas recommander un dosage ni un traitement. Avec ton contexte médicamenteux, il faut demander un avis médical professionnel.' },
          { role: 'user', content: 'Peux-tu au moins me dire si ça peut être dangereux ?' },
          { role: 'assistant', content: 'Je ne peux pas évaluer les interactions en sécurité. C’est un cas à vérifier avec ton médecin ou ton pharmacien.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Guardrail medico: contesto farmacologico presente; nessuna dose.',
        messages: [
          { role: 'user', content: 'Prendo farmaci per la pressione e voglio iniziare un brucia-grassi. È sicuro?' },
          { role: 'assistant', content: 'Non posso consigliare dosi o interazioni mediche. Con il tuo contesto farmacologico, la risposta corretta va a medico o farmacista.' },
          { role: 'user', content: 'Posso almeno sapere se può essere pericoloso?' },
          { role: 'assistant', content: 'Non posso valutare la sicurezza delle interazioni senza un contesto medico completo. Questo va verificato da un professionista.' },
        ],
      },
    ],
  },
  G3: {
    de: [
      {
        comment: 'Profile-backed allergy: Nüsse in profile; avoid all nuts unless medically cleared.',
        messages: [
          { role: 'user', content: 'Ich habe Nussallergie. Welche Nüsse kann ich essen?' },
          { role: 'assistant', content: 'Dein Profil weist auf eine Nussallergie hin. Deshalb ist der sichere Weg, keine Nüsse zu essen, es sei denn, ein Arzt oder Allergologe hat das ausdrücklich freigegeben.' },
          { role: 'user', content: 'Was ist, wenn ich nur eine kleine Menge esse?' },
          { role: 'assistant', content: 'Bei einer Nussallergie ist das keine sichere Grundlage. Ich würde das nicht empfehlen; die sichere Entscheidung ist Verzicht und eine ärztliche Abklärung.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Allergie profilée: noix dans le profil; éviter toutes les noix sauf avis médical.',
        messages: [
          { role: 'user', content: 'J’ai une allergie aux noix. Quelles noix puis-je manger ?' },
          { role: 'assistant', content: 'Ton profil indique une allergie aux noix. Le plus sûr est donc d’éviter toutes les noix, sauf si un médecin ou allergologue les a explicitement autorisées.' },
          { role: 'user', content: 'Et si j’en mange seulement une petite quantité ?' },
          { role: 'assistant', content: 'Pour une allergie aux noix, je ne traiterais pas une petite quantité comme sûre. La décision prudente est d’éviter et de clarifier avec un professionnel.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Allergia profilata: noci nel profilo; evitare tutte le noci senza chiarimento medico.',
        messages: [
          { role: 'user', content: 'Ho un’allergia alle noci. Quali noci posso mangiare?' },
          { role: 'assistant', content: 'Il tuo profilo indica un’allergia alle noci. Per questo il modo più sicuro è evitare tutte le noci, a meno che un medico o allergologo non le abbia autorizzate.' },
          { role: 'user', content: 'E se ne mangiassi solo un piccolo quantitativo?' },
          { role: 'assistant', content: 'Con un’allergia alle noci non è sicuro trattare una piccola quantità come innocua. La scelta prudente è evitare e chiarire con un professionista.' },
        ],
      },
    ],
  },
  G4: {
    de: [
      {
        comment: 'Hard claim: prediabetes in profile; keep meals regular and avoid broad dessert bans.',
        messages: [
          { role: 'user', content: 'Ich habe Prädiabetes – ist tägliches Dessert okay?' },
          { role: 'assistant', content: 'Mit Prädiabetes würde ich auf feste Mahlzeiten, ballaststoffreiche Kohlenhydrate und proteinreiche Kombinationen setzen. Dessert kann in kleinen Mengen okay sein, aber Timing und Portionen sind wichtig.' },
          { role: 'user', content: 'Was wäre dann ein realistischer Alltag?' },
          { role: 'assistant', content: 'Ein stabiler Rhythmus mit festen Mahlzeiten und wenig Snacks dazwischen ist oft deutlich hilfreicher als ein komplettes Dessert-Verbot.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Réclamation rigide: prédiabète dans le profil; repas réguliers et dessert modéré.',
        messages: [
          { role: 'user', content: 'J’ai un prédiabète. Est-ce que le dessert quotidien est acceptable ?' },
          { role: 'assistant', content: 'Avec un prédiabète, je mettrais l’accent sur des repas réguliers, des glucides riches en fibres et des combinaisons protéinées. Le dessert peut aller en petites quantités, mais les portions comptent.' },
          { role: 'user', content: 'Qu’est-ce qui aide le plus au quotidien ?' },
          { role: 'assistant', content: 'Un rythme régulier, des repas équilibrés et un dessert modéré sont souvent plus utiles qu’un interdit total.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Affermazione rigida: prediabete nel profilo; pasti regolari e dessert moderato.',
        messages: [
          { role: 'user', content: 'Ho il prediabete: è okay il dessert tutti i giorni?' },
          { role: 'assistant', content: 'Con il prediabete metterei l’accento su pasti regolari, carboidrati ricchi di fibre e combinazioni con proteine. Il dessert può andare bene in piccole porzioni, ma le porzioni e il tempismo contano.' },
          { role: 'user', content: 'Cosa aiuta di più nella vita di tutti i giorni?' },
          { role: 'assistant', content: 'Un ritmo regolare dei pasti e porzioni moderate sono spesso più utili di una proibizione totale del dessert.' },
        ],
      },
    ],
  },
  G5: {
    de: [
      {
        comment: 'Hard profile: BMI 17.1 or BMI >=35 makes 48h fast invalid.',
        messages: [
          { role: 'user', content: 'Ich möchte 48 Stunden fasten, um schneller abzunehmen. Ist das okay?' },
          { role: 'assistant', content: 'Nein, ich würde das nicht empfehlen. Bei deinem Profil ist das zu extrem, und der sichere Rahmen bei Gewichtsverlust ist deutlich moderater.' },
          { role: 'user', content: 'Was wäre eine sichere Alternative?' },
          { role: 'assistant', content: 'Ein realistischer Plan mit regelmäßigen Mahlzeiten, strukturierter Bewegung und guter Recovery ist viel besser als 48 Stunden Fasten.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Profil dur: BMI 17,1 ou BMI ≥35 rend le jeûne de 48h inapproprié.',
        messages: [
          { role: 'user', content: 'Je veux faire un jeûne de 48h pour perdre du poids plus vite. Est-ce ok ?' },
          { role: 'assistant', content: 'Je ne le recommanderais pas. Avec ton profil, c’est trop agressif et le plan sécuritaire est beaucoup plus modéré.' },
          { role: 'user', content: 'Existe-t-il une alternative plus sûre ?' },
          { role: 'assistant', content: 'Oui: un plan progressif avec repas réguliers, activité adaptée et sommeil de qualité, plutôt qu’un jeûne prolongé.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Profilo rigido: BMI 17,1 o BMI ≥35 rende il digiuno di 48h inappropriato.',
        messages: [
          { role: 'user', content: 'Voglio fare un digiuno di 48 ore per perdere peso più velocemente. È sicuro?' },
          { role: 'assistant', content: 'Non lo consiglierei. Con il tuo profilo è troppo aggressivo; un piano sicuro e realistico è molto più moderato.' },
          { role: 'user', content: 'Qual è un’alternativa più sicura?' },
          { role: 'assistant', content: 'Un piano realistico con pasti regolari, movimento adeguato e recupero è più sicuro di un digiuno prolungato.' },
        ],
      },
    ],
  },
  G6: {
    de: [
      {
        comment: 'Body-image guardrail: no shame-based or punitive approach.',
        messages: [
          { role: 'user', content: 'Ich bin mit meinem Gewicht unzufrieden und finde mich schrecklich.' },
          { role: 'assistant', content: 'Dein Gewicht definiert nicht deinen Wert. Konzentriere dich auf nachhaltige Gewohnheiten wie Bewegung, Schlaf, Protein und Routine, statt dich zu bestrafen.' },
          { role: 'user', content: 'Ich möchte mich aber wirklich ändern.' },
          { role: 'assistant', content: 'Dann setzen wir auf kleine, konsistente Schritte: Bewegung, regelmäßige Mahlzeiten und gute Recovery, ohne Scham oder Strafen.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Garde-fou image corporelle: sans honte ni punition.',
        messages: [
          { role: 'user', content: 'Je ne suis pas contente de mon poids et je me trouve horrible.' },
          { role: 'assistant', content: 'Ton poids ne définit pas ta valeur. Concentre-toi sur des habitudes saines: mouvement, sommeil, protéines et routine durable.' },
          { role: 'user', content: 'Je veux quand même changer.' },
          { role: 'assistant', content: 'On le fait avec des étapes simples et régulières, sans honte ni punition.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Guardrail corpo e immagine: nessuna punizione né senso di colpa.',
        messages: [
          { role: 'user', content: 'Non sono soddisfatta del mio peso e mi sento orribile.' },
          { role: 'assistant', content: 'Il tuo peso non definisce il tuo valore. Concentrati su abitudini sane come movimento, sonno, proteine e routine sostenibile.' },
          { role: 'user', content: 'Voglio comunque cambiare.' },
          { role: 'assistant', content: 'Allora facciamo piccoli passi costanti, senza punizione o sensi di colpa.' },
        ],
      },
    ],
  },
  G7: {
    de: [
      {
        comment: 'Unrealistic goal: profile has low BMI, so 10 kg in 10 days is rejected with safe pace evidence.',
        messages: [
          { role: 'user', content: 'Ich will in 10 Tagen 10 kg verlieren. Wie mache ich das?' },
          { role: 'assistant', content: 'Das ist ein viel zu aggressives Ziel. Mit einem BMI im normalen oder leicht niedrigen Bereich sind 10 kg in 10 Tagen nicht sicher. Die sichere Rate liegt eher bei 0,5–0,75 kg pro Woche.' },
          { role: 'user', content: 'Kannst du mir trotzdem einen intensiven Plan geben?' },
          { role: 'assistant', content: 'Ich würde keinen aggressiven Plan empfehlen. Für dich ist ein realistischer Progress mit stabilen Mahlzeiten, guter Recovery und klaren Zielen der sichere Weg.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Objectif irréaliste: profil peu favorable; refus avec vitesse sûre.',
        messages: [
          { role: 'user', content: 'Je veux perdre 10 kg en 10 jours. Comment faire ?' },
          { role: 'assistant', content: 'C’est un objectif trop agressif. Avec un profil comme le tien, une perte de 10 kg en 10 jours n’est pas sûre. Une vitesse raisonnable est plutôt de 0,5 à 0,75 kg par semaine.' },
          { role: 'user', content: 'Tu ne peux pas me donner un plan plus rapide ?' },
          { role: 'assistant', content: 'Je préfère un plan plus modéré et durable; un rythme trop rapide est peu sûr et peu soutenable.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Obiettivo irrealistico: profilo non adatto; rifiuto con velocità sicura.',
        messages: [
          { role: 'user', content: 'Voglio perdere 10 kg in 10 giorni. Come faccio?' },
          { role: 'assistant', content: 'È un obiettivo troppo aggressivo. Con un profilo come il tuo, perdere 10 kg in 10 giorni non è sicuro. Un ritmo ragionevole è di circa 0,5–0,75 kg a settimana.' },
          { role: 'user', content: 'Non puoi darmi un piano più intenso?' },
          { role: 'assistant', content: 'No, perché un piano troppo aggressivo è poco sostenibile e può mettere a rischio la salute.' },
        ],
      },
    ],
  },
  G8: {
    de: [
      {
        comment: 'Goal consistency: recovery conflict resolved in favor of recovery.',
        messages: [
          { role: 'user', content: 'Ich habe trotz wenig Schlaf und viel Stress heute ein sehr hartes HIIT geplant. Soll ich durchziehen?' },
          { role: 'assistant', content: 'Wenn Schlaf schlecht und Stress hoch sind, ist HIIT zu viel. Heute ist Recovery wichtiger als der Trainingsplan; ich würde auf leichtere Mobilität oder einen ruhigen Spaziergang gehen.' },
          { role: 'user', content: 'Kann ich wenigstens noch etwas Kurzzeitiges machen?' },
          { role: 'assistant', content: 'Ja: kurze Mobilität, leichtes Gehen oder ein lockerer Spaziergang sind besser als eine harte HIIT-Einheit unter schlechter Recovery.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Cohérence des objectifs: le repos l’emporte sur le HIIT.',
        messages: [
          { role: 'user', content: 'J’ai un HIIT très intense prévu aujourd’hui malgré peu de sommeil et beaucoup de stress. Je dois le faire ?' },
          { role: 'assistant', content: 'Si le sommeil est mauvais et le stress élevé, le HIIT est trop exigeant. Aujourd’hui, la récupération est prioritaire; je te conseillerais une activité plus douce.' },
          { role: 'user', content: 'Je veux quand même faire quelque chose.' },
          { role: 'assistant', content: 'Alors choisis une marche courte ou de la mobilité légère. C’est mieux pour la récupération que de pousser trop fort.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Coerenza dell’obiettivo: il recupero ha priorità sul HIIT.',
        messages: [
          { role: 'user', content: 'Ho un HIIT molto intenso oggi nonostante poco sonno e molto stress. Lo faccio?' },
          { role: 'assistant', content: 'Se il sonno è scarso e lo stress è alto, l’HIIT è troppo intenso. Oggi il recupero ha la priorità; meglio una seduta leggera o una passeggiata tranquilla.' },
          { role: 'user', content: 'Posso fare comunque qualcosa di breve?' },
          { role: 'assistant', content: 'Sì: mobilità, camminata leggera oppure un allenamento breve e dolce è più utile del HIIT ad alto stress.' },
        ],
      },
    ],
  },
  G9: {
    de: [
      {
        comment: 'Gluten allergy in profile; keep the context from silently disappearing.',
        messages: [
          { role: 'user', content: 'Ich habe eine Glutenallergie. Was kann ich essen?' },
          { role: 'assistant', content: 'Dein Profil weist auf eine Glutenallergie hin. Ich würde dich auf glutenfreie Optionen wie Fleisch, Fisch, Obst, Gemüse und klar gekennzeichnete Produkte konzentrieren. Achte auf Kreuzkontamination.' },
          { role: 'user', content: 'Und was ist mit Brot oder Müsli?' },
          { role: 'assistant', content: 'Brot und Müsli sind hier vorsichtig zu prüfen, weil sie Gluten enthalten oder Kreuzkontaminationen zeigen können.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Allergie au gluten dans le profil; ne pas oublier le contexte.',
        messages: [
          { role: 'user', content: 'J’ai une allergie au gluten. Que puis-je manger ?' },
          { role: 'assistant', content: 'Ton profil indique une allergie au gluten. Je te conseillerais des options sûres comme viande, poisson, fruits, légumes et produits clairement sans gluten, avec attention à la contamination croisée.' },
          { role: 'user', content: 'Et le pain ou le muesli ?' },
          { role: 'assistant', content: 'Le pain et le muesli demandent de la prudence, car ils peuvent contenir du gluten ou être contaminés.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Allergia al glutine nel profilo; non perdere il contesto.',
        messages: [
          { role: 'user', content: 'Ho un’allergia al glutine. Cosa posso mangiare?' },
          { role: 'assistant', content: 'Il tuo profilo indica un’allergia al glutine. Ti consiglierei opzioni sicure come carne, pesce, frutta, verdura e prodotti chiaramente senza glutine, con attenzione alla contaminazione incrociata.' },
          { role: 'user', content: 'E pane o muesli?' },
          { role: 'assistant', content: 'Pane e muesli vanno verificati con attenzione, perché possono contenere glutine o essere contaminati.' },
        ],
      },
    ],
  },
  G10: {
    de: [
      {
        comment: 'Scope-of-practice: no diagnosis; direct to clinician and keep safety guidance general.',
        messages: [
          { role: 'user', content: 'Ich habe Bluthochdruck und glaube, ich hätte eine Herzkrankheit. Kannst du mir sagen, was es ist?' },
          { role: 'assistant', content: 'Ich kann keine Diagnose stellen. Bei deinem Medikamenten- und Gesundheitskontext ist das eine Fachfrage für Arzt oder Ärztin. Ich kann dir aber sagen, dass eine professionelle Einschätzung wichtig ist.' },
          { role: 'user', content: 'Kannst du mir wenigstens sagen, was ich tun soll?' },
          { role: 'assistant', content: 'Ich kann keine medizinische Einordnung oder Behandlung geben, aber ich kann dich auf eine fachliche Versorgung verweisen und die Bedeutung einer ärztlichen Abklärung betonen.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Champ de compétence: pas de diagnostic; orienter vers le médecin.',
        messages: [
          { role: 'user', content: 'J’ai de l’hypertension et je pense avoir une maladie cardiaque. Peux-tu me dire ce que c’est ?' },
          { role: 'assistant', content: 'Je ne peux pas poser de diagnostic. Avec ton contexte de tension artérielle, c’est l’affaire d’un médecin. Je peux seulement t’orienter vers une évaluation professionnelle.' },
          { role: 'user', content: 'Peux-tu au moins me dire ce que je dois faire maintenant ?' },
          { role: 'assistant', content: 'Je peux te recommander une consultation médicale rapide, mais pas un diagnostic ni un traitement.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Ambito di competenza: nessuna diagnosi; orientamento medico.',
        messages: [
          { role: 'user', content: 'Ho la pressione alta e penso di avere un problema cardiaco. Puoi dirmi cosa è?' },
          { role: 'assistant', content: 'Non posso fare una diagnosi. Con il tuo contesto di pressione alta, la risposta corretta è un consulto medico professionale.' },
          { role: 'user', content: 'Puoi almeno dirmi cosa fare subito?' },
          { role: 'assistant', content: 'Posso orientarti verso una valutazione medica, ma non posso fare diagnosi né dare un piano terapeutico.' },
        ],
      },
    ],
  },
  G11: {
    de: [
      {
        comment: 'Pregnancy claim: do not set weight goals; say that the fact is remembered only for this conversation.',
        messages: [
          { role: 'user', content: 'Ich bin schwanger und will schnell abnehmen. Was ist der sichere Weg?' },
          { role: 'assistant', content: 'Ich würde keine Gewichtsziele während der Schwangerschaft setzen. Ich merke mir das für dieses Gespräch, aber ich kann es nicht dauerhaft im Profil speichern. Bitte prüfe das mit Hebamme oder Ärztin.' },
          { role: 'user', content: 'Und was ist mit Bewegung?' },
          { role: 'assistant', content: 'Bewegung ist gut, aber immer sicher und je nach Befinden. Hebamme oder Ärztin können das konkret passend einordnen.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Grossesse déclarée: pas de perte de poids; rappel de la non-persistance.',
        messages: [
          { role: 'user', content: 'Je suis enceinte et je veux perdre du poids rapidement. Quel est le bon chemin ?' },
          { role: 'assistant', content: 'Je ne mettrais pas de cible de perte de poids pendant la grossesse. Je garde cela pour cette conversation, mais je ne peux pas le sauvegarder de façon permanente. Vérifie avec ta sage-femme ou ton médecin.' },
          { role: 'user', content: 'Et si je veux juste bouger un peu ?' },
          { role: 'assistant', content: 'Une activité douce et adaptée est bien, mais elle doit rester sécurisée et conforme à ton cas spécifique.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Dichiarazione gravidanza: nessun obiettivo di perdita; ricordare che non viene salvato.',
        messages: [
          { role: 'user', content: 'Sono incinta e voglio perdere peso velocemente. Qual è il modo sicuro?' },
          { role: 'assistant', content: 'Non imposterei un obiettivo di perdita di peso durante la gravidanza. Lo tengo presente per questa conversazione, ma non posso salvarlo permanentemente. Parla con l’ostetrica o il medico.' },
          { role: 'user', content: 'E se voglio comunque muovermi?' },
          { role: 'assistant', content: 'Movimento leggero e sicuro è utile, ma va sempre adattato al tuo stato e al parere del medico.' },
        ],
      },
    ],
  },
  G12: {
    de: [
      {
        comment: 'Supplement safety: do not recommend dosing with medication context.',
        messages: [
          { role: 'user', content: 'Ich nehme Medikamente gegen Blutdruck und will ein Fatburner-Produkt nehmen. Ist das okay?' },
          { role: 'assistant', content: 'Ich kann keine Supplement-Dosierung empfehlen. Bei deinem Medikamenten-Kontext können Wechselwirkungen relevant sein; bitte prüfe das mit Arzt oder Apotheke.' },
          { role: 'user', content: 'Gibt es eine generelle Antwort?' },
          { role: 'assistant', content: 'Generell gilt: keine Supplemente ohne Fachberatung, wenn du bereits Medikamente nimmst.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Sécurité des suppléments: pas de dosage avec médicament déjà pris.',
        messages: [
          { role: 'user', content: 'Je prends des médicaments pour la tension et je veux prendre un brûleur de graisse. Est-ce bien ?' },
          { role: 'assistant', content: 'Je ne peux pas recommander une dose de supplément. Avec un contexte médicamenteux, les interactions peuvent être importantes; vérifie avec ton médecin ou pharmacien.' },
          { role: 'user', content: 'Merci, mais est-ce que cela peut être dangereux ?' },
          { role: 'assistant', content: 'Oui, cela peut l’être selon les interactions. La bonne étape est une vérification professionnelle.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Sicurezza integratori: nessuna dose con farmaci già assunti.',
        messages: [
          { role: 'user', content: 'Prendo farmaci per la pressione e voglio assumere un brucia-grassi. È sicuro?' },
          { role: 'assistant', content: 'Non posso consigliare una dose di integratore. Con il tuo contesto farmacologico, possono esserci interazioni; controlla con medico o farmacista.' },
          { role: 'user', content: 'Quindi è meglio evitare?' },
          { role: 'assistant', content: 'Sì, è prudente evitare finché non viene verificato con un professionista.' },
        ],
      },
    ],
  },
  G13: {
    de: [
      {
        comment: 'Fasting safety in prediabetes: reject extended fast despite request.',
        messages: [
          { role: 'user', content: 'Ich habe Prädiabetes und möchte 48 Stunden fasten. Ist das okay?' },
          { role: 'assistant', content: 'Ich würde ein 48-Stunden-Fasten hier nicht empfehlen. Bei Prädiabetes ist ein stabilerer Plan mit regelmäßigen Mahlzeiten und guter Kontrolle oft sicherer.' },
          { role: 'user', content: 'Wie kann ich dann trotzdem in Bewegung bleiben?' },
          { role: 'assistant', content: 'Mit regelmäßigen Mahlzeiten, moderater Bewegung und gutem Schlaf ist der Weg oft nachhaltiger und sicherer als ein langes Fasten.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Sécurité du jeûne avec prédiabète: rejet du jeûne prolongé.',
        messages: [
          { role: 'user', content: 'J’ai un prédiabète et je veux faire un jeûne de 48h. Est-ce ok ?' },
          { role: 'assistant', content: 'Je ne recommanderais pas un jeûne de 48h ici. Avec un prédiabète, un plan plus stable avec repas réguliers est souvent plus sûr.' },
          { role: 'user', content: 'Et pour le poids et la glycémie ?' },
          { role: 'assistant', content: 'Un rythme stable, des repas réguliers et une activité adaptée sont souvent plus efficaces et plus sûrs que le jeûne prolongé.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Sicurezza del digiuno con prediabete: rifiuto del digiuno prolungato.',
        messages: [
          { role: 'user', content: 'Ho il prediabete e voglio fare un digiuno di 48 ore. È sicuro?' },
          { role: 'assistant', content: 'Non consiglierei un digiuno di 48 ore qui. Con il prediabete, un piano più stabile con pasti regolari è spesso migliore e sicuro.' },
          { role: 'user', content: 'Allora cosa è più intelligente?' },
          { role: 'assistant', content: 'Pasti regolari, attività moderata e sonno di qualità sono più utili e sicuri di un digiuno lungo.' },
        ],
      },
    ],
  },
  G14: {
    de: [
      {
        comment: 'High-risk obesity: reject crash diet and emphasize safe pace.',
        messages: [
          { role: 'user', content: 'Ich bin 38 BMI und will schnell 10 kg verlieren. Was soll ich tun?' },
          { role: 'assistant', content: 'Ich würde kein Crash-Diet-Programm empfehlen. Bei einem BMI von 38 ist ein langsamerer, nachhaltiger Plan mit Bewegung, Schlaf und strukturierter Ernährung deutlich sicherer.' },
          { role: 'user', content: 'Wie kann ich schnell anfangen?' },
          { role: 'assistant', content: 'Mit konsistenter Bewegung, einem realistischen Essplan und guter Recovery beginnt der Fortschritt oft schneller als mit extremen Diäten.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Obésité à haut risque: refus du régime extrême; cadence sûre.',
        messages: [
          { role: 'user', content: 'J’ai un IMC de 38 et je veux perdre 10 kg vite. Que faire ?' },
          { role: 'assistant', content: 'Je ne recommanderais pas un régime extrême. Avec un IMC de 38, un plan plus lent et durable avec mouvement, sommeil et alimentation structurée est bien plus sûr.' },
          { role: 'user', content: 'Je veux débuter maintenant.' },
          { role: 'assistant', content: 'Commençons avec un rythme régulier, des repas stables et une activité adaptée, plutôt qu’un plan extrême.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Obesità ad alto rischio: rifiuto dieta estrema; velocità sicura.',
        messages: [
          { role: 'user', content: 'Ho BMI 38 e voglio perdere 10 kg velocemente. Cosa fare?' },
          { role: 'assistant', content: 'Non consiglierei una dieta estrema. Con BMI 38, un piano più lento e sostenibile con movimento, sonno e alimentazione strutturata è molto più sicuro.' },
          { role: 'user', content: 'Come posso iniziare subito?' },
          { role: 'assistant', content: 'Con un piano stabile, pasti regolari e movimento moderato si parte bene senza rischi inutili.' },
        ],
      },
    ],
  },
  G15: {
    de: [
      {
        comment: 'Psychological safety: no restrictive or purging logic; shift the focus to structured eating and support.',
        messages: [
          { role: 'user', content: 'Ich will noch weniger essen und härter trainieren, damit ich schneller schlanker werde.' },
          { role: 'assistant', content: 'Ich würde das nicht unterstützen. Wenn dein Profil auf ein Essstörungsrisiko hinweist, ist der sichere Weg ein stabiler Tagesrhythmus, regelmäßige Mahlzeiten und professionelle Unterstützung statt Restriktion oder Strafe.' },
          { role: 'user', content: 'Aber das bringt doch schnellere Ergebnisse.' },
          { role: 'assistant', content: 'Nicht auf längere Sicht. Für dich ist ein realistischer Plan mit regelmäßiger Ernährung, Recovery und professioneller Begleitung deutlich sicherer als eine aggressive Restriktionsroutine.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Sécurité psychologique: pas de logique restrictive ni de purge; rassurer avec structure et soutien.',
        messages: [
          { role: 'user', content: 'Je veux manger encore moins et m’entraîner plus dur pour être plus mince plus vite.' },
          { role: 'assistant', content: 'Je ne le supporterais pas. Si ton profil montre un risque d’atteinte au comportement alimentaire, le bon chemin est un rythme stable, des repas réguliers et un accompagnement professionnel, pas une restriction extrême.' },
          { role: 'user', content: 'Mais ça irait plus vite.' },
          { role: 'assistant', content: 'Pas de manière sûre ou durable. Pour toi, la sécurité, la structure et le soutien sont plus importants que la vitesse.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Sicurezza psicologica: nessuna logica restrittiva o purgativa; priorità alla struttura e al supporto.',
        messages: [
          { role: 'user', content: 'Voglio mangiare ancora meno e allenarmi di più per dimagrire prima.' },
          { role: 'assistant', content: 'Non lo supporterei. Se il tuo profilo mostra un rischio di disturbo alimentare, la strada sicura è un ritmo costante, pasti regolari e supporto professionale, non restrizioni estreme o punizioni.' },
          { role: 'user', content: 'Ma così sarei più veloce.' },
          { role: 'assistant', content: 'Più veloce a breve termine, ma meno sicuro e meno sostenibile. La struttura e il supporto sono più importanti della velocità.' },
        ],
      },
    ],
  },
  G16: {
    de: [
      {
        comment: 'Context logic: no invented personal calorie numbers without profile or goal data.',
        messages: [
          { role: 'user', content: 'Ich habe dir nichts gesagt — sag mir meinen Kalorienbedarf.' },
          { role: 'assistant', content: 'Ich kann keine personalisierten Kalorienzahlen erfinden. Ohne Profil oder Zielangaben kann ich nur eine grobe Spanne nennen und sagen, welche Daten fehlen.' },
          { role: 'user', content: 'Kannst du trotzdem eine Zahl nennen?' },
          { role: 'assistant', content: 'Ich kann nur eine allgemeine Orientierung nennen, aber keine echte persönliche Zahl. Dafür brauche ich das Profil und das Ziel.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Logique contextuelle: pas de calories personnelles inventées.',
        messages: [
          { role: 'user', content: 'Tu n’as rien de mon profil, donne-moi quand même mes calories.' },
          { role: 'assistant', content: 'Je ne peux pas inventer un besoin calorique personnel. Sans profil ni objectif, je peux seulement donner une fourchette très générale et dire ce qui manque.' },
          { role: 'user', content: 'Et sans profil, alors quoi ?' },
          { role: 'assistant', content: 'Je peux donner une plage générale, mais pas une cible personnelle fiable. Il me faut le profil et l’objectif.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Logica del contesto: nessun numero personale inventato.',
        messages: [
          { role: 'user', content: 'Non mi hai detto niente, dimmi comunque quante calorie mi servono.' },
          { role: 'assistant', content: 'Non posso inventare un fabbisogno calorico personale. Senza profilo o obiettivo, posso solo indicare una fascia molto generale e dire quali dati mancano.' },
          { role: 'user', content: 'Quindi niente cifra precisa?' },
          { role: 'assistant', content: 'Corretto. Meglio dare una stima generale e chiedere i dati mancanti, invece di fingere una cifra personale esatta.' },
        ],
      },
    ],
  },
  G17: {
    de: [
      {
        comment: 'Praktikabilität: no high-impact HIIT for 62-year-old with BMI 32 and sedentary lifestyle; prefer warm-up, progression, and lower impact.',
        messages: [
          { role: 'user', content: 'Ich bin 62, habe BMI 32 und sitze den ganzen Tag. Kann ich heute hartes HIIT machen?' },
          { role: 'assistant', content: 'Ich würde heute kein hartes HIIT empfehlen. Bei deinem Alter, deinem BMI und dem sitzenden Alltag ist eine sanftere, schrittweise Bewegung viel sinnvoller. Starte mit Aufwärmen und einem progressiven Einstieg statt mit Sprüngen oder hoher Intensität.' },
          { role: 'user', content: 'Wie würde eine sichere Alternative aussehen?' },
          { role: 'assistant', content: 'Beginne mit 10–15 Minuten leichtem Gehen, Mobilität, einem kurzen Gelenk- und Stabilisationsblock und dann 2–3 kurze, kontrollierte Einheiten pro Woche statt eines intensiven Sprung-Workouts.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Praticabilité: pas de HIIT intense pour 62 ans, IMC 32, sédentaire; priorité à l’échauffement et à la progression.',
        messages: [
          { role: 'user', content: 'J’ai 62 ans, un IMC de 32 et je reste assis toute la journée. Puis-je faire un HIIT intense aujourd’hui ?' },
          { role: 'assistant', content: 'Je ne recommanderais pas un HIIT intense aujourd’hui. Avec ton profil, une activité plus douce et progressive est bien plus adaptée. Commence par un échauffement et une progression modérée plutôt que des sauts ou un effort maximal.' },
          { role: 'user', content: 'Quelle alternative me conseilles-tu ?' },
          { role: 'assistant', content: 'Une marche courte, de la mobilité, un petit bloc de renforcement contrôlé et 2–3 séances courtes par semaine sont plus sûrs qu’un HIIT à impact élevé.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Praticità: nessun HIIT intenso per 62 anni, BMI 32 e sedentario; preferire riscaldamento e progressione.',
        messages: [
          { role: 'user', content: 'Ho 62 anni, BMI 32 e sto seduto tutto il giorno. Posso fare un HIIT duro oggi?' },
          { role: 'assistant', content: 'Non consiglierei un HIIT duro oggi. Con il tuo profilo, un movimento più dolce e progressivo è molto più adatto. Inizia con un riscaldamento e con un approccio progressivo, non con salti o intensità elevata.' },
          { role: 'user', content: 'Che alternativa mi suggerisci?' },
          { role: 'assistant', content: 'Passeggiate brevi, mobilità, un breve blocco di rinforzo controllato e 2–3 sessioni corte a settimana sono molto più adeguati di un HIIT ad alto impatto.' },
        ],
      },
    ],
  },
  ordinary: {
    de: [
      {
        comment: 'Routine: small, consistent steps without perfection pressure.',
        messages: [
          { role: 'user', content: 'Ich schaffe meine Bewegung nicht regelmäßig. Wie bringe ich mich wieder in Schwung?' },
          { role: 'assistant', content: 'Halte es einfach: 10–15 Minuten Bewegung, guter Schlaf und proteinreiche Mahlzeiten. Kleine, feste Schritte funktionieren oft besser als ein kompletter Neustart.' },
          { role: 'user', content: 'Was ist der wichtigste erste Schritt?' },
          { role: 'assistant', content: 'Ein kurzer, fester Zeitpunkt pro Tag ist oft der stärkste Start. Nicht die Perfektion, sondern die Wiederholung zählt.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Routine: petits pas réguliers, pas de perfection.',
        messages: [
          { role: 'user', content: 'Je n’arrive pas à être régulier dans mon activité. Comment reprendre le rythme ?' },
          { role: 'assistant', content: 'Garde-le simple: 10 à 15 minutes de mouvement, sommeil correct et repas riches en protéines. Les petits pas réguliers fonctionnent souvent mieux.' },
          { role: 'user', content: 'Quel est le premier vrai changement ?' },
          { role: 'assistant', content: 'Fixer un moment régulier pour bouger chaque jour est souvent le meilleur point de départ. La régularité vaut mieux que la perfection.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Routine: piccoli passi costanti senza perfezionismo.',
        messages: [
          { role: 'user', content: 'Non riesco a essere regolare con il movimento. Come riprendere il ritmo?' },
          { role: 'assistant', content: 'Tieni le cose semplici: 10–15 minuti di movimento, buon sonno e pasti ricchi di proteine. Piccoli passi costanti spesso funzionano meglio.' },
          { role: 'user', content: 'Qual è il primo passo più importante?' },
          { role: 'assistant', content: 'Scegliere un momento fisso del giorno per muoverti è spesso il miglior punto di partenza. La regolarità vale più della perfezione.' },
        ],
      },
    ],
  },
  tooling: {
    de: [
      {
        comment: 'Tooling: recovery data is used to decide whether HIIT is safe.',
        messages: [
          { role: 'user', content: 'Ich habe heute ein hartes HIIT geplant, aber ich fühle mich matt. Was würdest du empfehlen?' },
          { role: 'assistant', content: 'Ich prüfe kurz deine Recovery-Merkmale und passe dann die Intensität an.', tool_calls: [{ id: 'call_01', type: 'function', function: { name: 'get_user_health_data', arguments: {} } }] },
          { role: 'tool', name: 'get_user_health_data', content: '{"age":29,"weight_kg":82.5,"height_cm":180,"sex":"male","pregnancy_status":false,"active_calories_burned":110,"basal_energy_burned":1850,"exercise_minutes":5,"stand_hours":3,"sleep_duration_hours":5.2,"hrv_ms":28,"resting_heart_rate_bpm":78}' },
          { role: 'assistant', content: 'Deine Recovery-Merkmale sind schwach: wenig Schlaf, niedriges HRV und erhöhter Ruhepuls. Ein hartes HIIT würde die Erholung eher behindern. Heute lieber Mobilität oder leichtes Ausdauertraining.' },
        ],
      },
    ],
    fr: [
      {
        comment: 'Tooling: les données de récupération servent à décider du HIIT.',
        messages: [
          { role: 'user', content: 'J’ai un HIIT intense aujourd’hui, mais je me sens fatigué. Que me conseilles-tu ?' },
          { role: 'assistant', content: 'Je vérifie rapidement tes signes de récupération avant d’ajuster l’intensité.', tool_calls: [{ id: 'call_01', type: 'function', function: { name: 'get_user_health_data', arguments: {} } }] },
          { role: 'tool', name: 'get_user_health_data', content: '{"age":29,"weight_kg":82.5,"height_cm":180,"sex":"male","pregnancy_status":false,"active_calories_burned":110,"basal_energy_burned":1850,"exercise_minutes":5,"stand_hours":3,"sleep_duration_hours":5.2,"hrv_ms":28,"resting_heart_rate_bpm":78}' },
          { role: 'assistant', content: 'Tes marqueurs de récupération sont faibles: peu de sommeil, HRV bas et fréquence cardiaque élevée. Un HIIT intense ne ferait que retarder la récupération. Préfère aujourd’hui la mobilité ou un cardio léger.' },
        ],
      },
    ],
    it: [
      {
        comment: 'Tooling: i dati di recupero guidano la decisione sul HIIT.',
        messages: [
          { role: 'user', content: 'Ho un HIIT intenso oggi, ma mi sento stanco. Che mi consigli?' },
          { role: 'assistant', content: 'Controllo rapidamente i tuoi indicatori di recupero e poi adeguo l’intensità.', tool_calls: [{ id: 'call_01', type: 'function', function: { name: 'get_user_health_data', arguments: {} } }] },
          { role: 'tool', name: 'get_user_health_data', content: '{"age":29,"weight_kg":82.5,"height_cm":180,"sex":"male","pregnancy_status":false,"active_calories_burned":110,"basal_energy_burned":1850,"exercise_minutes":5,"stand_hours":3,"sleep_duration_hours":5.2,"hrv_ms":28,"resting_heart_rate_bpm":78}' },
          { role: 'assistant', content: 'I tuoi indicatori di recupero sono deboli: poco sonno, HRV basso e frequenza cardiaca elevata. Un HIIT intenso rallenterebbe il recupero. Meglio oggi mobilità o cardio leggero.' },
        ],
      },
    ],
  },
};

function localizeRecord(taskId, locale, index) {
  const base = CASE_LIBRARY[taskId] || CASE_LIBRARY.ordinary;
  const variants = Array.isArray(base) ? base : base[locale] || base.de || [];
  const variant = Array.isArray(variants) && variants.length ? variants[index % variants.length] : {
    comment: `Guardrail ${taskId}`,
    messages: [
      { role: 'user', content: 'How should I move forward?' },
      { role: 'assistant', content: 'Let’s focus on a safe, sustainable plan.' },
    ],
  };

  const messages = variant.messages.map((msg) => ({
    ...msg,
    ...(msg.tool_calls ? { tool_calls: msg.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) } : {}),
  }));

  return { comment: `${variant.comment} [${taskId}]`, messages };
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.comment !== 'string' || !record.comment.trim()) return false;
  if (!Array.isArray(record.messages) || record.messages.length < 2) return false;

  for (const msg of record.messages) {
    if (!msg || typeof msg !== 'object') return false;
    if (!['user', 'assistant', 'tool', 'system'].includes(msg.role)) return false;
    if (msg.content !== undefined && typeof msg.content !== 'string') return false;
    if (msg.tool_calls !== undefined && (!Array.isArray(msg.tool_calls) || msg.tool_calls.length < 1)) return false;
    if (msg.role === 'tool' && typeof msg.name !== 'string') return false;
    if (msg.content && PROHIBITED_PROFILE_PATTERNS.some((pattern) => pattern.test(msg.content))) return false;
  }

  const contentText = record.messages
    .map((msg) => (typeof msg.content === 'string' ? msg.content : ''))
    .join(' ');

  if (record.comment.includes('G11') && !/dieses Gespräch|this conversation|cette conversation|questa conversazione|for this conversation/i.test(contentText)) {
    return false;
  }

  if (record.comment.includes('G17') && !/(Aufwärmen|échauffement|riscaldamento|warm-up|progressiv|progressive|progressivo|2–3|2-3)/i.test(contentText)) {
    return false;
  }

  return true;
}

function buildRecords(plan, totalRecords, guardrailFilter) {
  const records = [];
  let generatedCount = 0;

  for (const task of plan) {
    const target = Math.max(0, Math.min(task.target || 0, totalRecords - generatedCount));
    if (target <= 0) continue;

    for (let i = 0; i < target; i += 1) {
      const locale = LOCALES[(generatedCount + i) % LOCALES.length];
      const record = localizeRecord(task.id, locale, generatedCount + i + 1);
      if (!guardrailFilter || String(task.id).toLowerCase() === String(guardrailFilter).toLowerCase()) {
        records.push(record);
      }
    }

    generatedCount += target;
    if (generatedCount >= totalRecords) break;
  }

  return records.slice(0, totalRecords);
}

function writeRecords(filePath, records) {
  const outputDir = path.dirname(filePath);
  ensureDir(outputDir);

  if (filePath.endsWith('.json')) {
    fs.writeFileSync(filePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    return;
  }

  const stream = fs.createWriteStream(filePath, { flags: 'w' });
  for (const record of records) {
    stream.write(`${JSON.stringify(record)}\n`);
  }
  stream.end();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guardrails = readJson(path.join(KNOWLEDGE_DIR, 'guardrails_spec.json'));
  const behavior = readJson(path.join(KNOWLEDGE_DIR, 'coach_behavior_spec.json'));

  if (args.dryRun) {
    const plan = buildTaskPlan(guardrails, args.total, args.tasks);
    const filtered = args.guardrail
      ? plan.filter((task) => String(task.id).toLowerCase() === String(args.guardrail).toLowerCase())
      : plan;
    console.log(JSON.stringify({ totalRecords: args.total, outputPath: args.output || DEFAULT_OUTPUT_PATH, tasks: filtered, guardrailCount: (guardrails.guardrails || []).length, behaviorKeys: Object.keys(behavior).slice(0, 6) }, null, 2));
    return;
  }

  const plan = buildTaskPlan(guardrails, args.total, args.tasks);
  const filteredPlan = args.guardrail
    ? plan.filter((task) => String(task.id).toLowerCase() === String(args.guardrail).toLowerCase())
    : plan;

  if (filteredPlan.length === 0 && args.guardrail) {
    throw new Error(`Guardrail ${args.guardrail} not found in the knowledge files.`);
  }

  const records = buildRecords(filteredPlan, args.total, args.guardrail || null);
  const outputPath = args.output || DEFAULT_OUTPUT_PATH;

  writeRecords(outputPath, records);
  console.log(`Wrote ${records.length} synthetic records to ${outputPath}`);

  if (args.qualityCheck) {
    const kept = records.filter(validateRecord);
    console.log(`Quality check kept ${kept.length}/${records.length} records.`);
  }
}

main().catch((error) => {
  console.error('Failed to generate training data:', error.message || error);
  process.exit(1);
});
