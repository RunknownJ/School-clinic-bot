const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Saint Joseph College Clinic Information
const CLINIC_INFO = {
  name: 'Saint Joseph College',
  dentist: {
    weekdays: 'Mon-Fri: 8:30-11:30 AM (10 slots) & 1:30-4:30 PM (10 slots)',
    saturday: 'Sat: 8:00-11:30 AM (half-day)',
    sunday: 'Not available'
  },
  doctor: {
    schedule: 'Tuesday, Wednesday, Thursday: 9:00 AM - 12:00 NN'
  },
  hospital: 'Dongon Hospital',
  medicines: ['Paracetamol', 'Dycolsen', 'Dycolgen', 'Loperamide', 'Erceflora', 'Antacid']
};

// User session management - tracks conversation context
const userSessions = new Map();

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      lastIntent: null,
      lastLang: 'en',
      conversationCount: 0,
      lastInteraction: Date.now(),
      waitingFor: null,
      context: {}
    });
  }
  
  const session = userSessions.get(userId);
  session.lastInteraction = Date.now();
  session.conversationCount++;
  
  return session;
}

// Clean up old sessions (older than 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastInteraction > 1800000) {
      userSessions.delete(userId);
    }
  }
}, 300000); // Check every 5 minutes

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    body.entry.forEach(entry => {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;

      if (webhookEvent.message) {
        handleMessage(senderId, webhookEvent.message);
      } else if (webhookEvent.postback) {
        handlePostback(senderId, webhookEvent.postback);
      }
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Enhanced language detection with scoring
function detectLanguage(text) {
  const tagalogPatterns = {
    common: ['kumusta', 'kamusta', 'ako', 'ikaw', 'siya', 'kami', 'tayo', 'kayo', 'sila', 'po', 'opo'],
    markers: ['ang', 'ng', 'mga', 'sa', 'ay', 'ko', 'mo', 'niya', 'natin', 'namin'],
    questions: ['kelan', 'kailan', 'saan', 'ano', 'sino', 'paano', 'bakit', 'magkano'],
    responses: ['oo', 'hindi', 'wala', 'may', 'meron', 'kailangan', 'gusto', 'pwede'],
    medical: ['ngipin', 'gamot', 'sakit', 'doktor', 'ospital', 'klinika', 'bunot', 'pamanhid'],
    greetings: ['magandang', 'umaga', 'hapon', 'gabi', 'salamat', 'pasensya']
  };
  
  const lowerText = text.toLowerCase();
  let tagalogScore = 0;
  
  // Score based on different pattern categories
  Object.entries(tagalogPatterns).forEach(([category, words]) => {
    const weight = category === 'markers' ? 2 : 1;
    words.forEach(word => {
      if (lowerText.includes(word)) tagalogScore += weight;
    });
  });
  
  return tagalogScore >= 2 ? 'tl' : 'en';
}

// Enhanced intent detection with confidence scoring
function detectIntent(text, session) {
  const intents = {
    greeting: {
      patterns: [/\b(hi|hello|hey|kumusta|kamusta|magandang|start|good\s*(morning|afternoon|evening))\b/i],
      confidence: text.length < 50 ? 1.0 : 0.7
    },
    dentist_schedule: {
      patterns: [
        /\b(dentist|ngipin|tooth|teeth|dental)\b.*\b(schedule|available|open|kelan|kailan|oras|time|sked)\b/i,
        /\b(kelan|kailan|when|schedule|available)\b.*\b(dentist|ngipin|dental)\b/i
      ],
      confidence: 0.9
    },
    dentist_appointment: {
      patterns: [
        /\b(appointment|book|mag.?book|kailangan.*appointment|need.*appointment)\b.*\b(dentist|ngipin|dental)\b/i,
        /\b(dentist|ngipin|dental)\b.*\b(appointment|book|reserve|pa.?appointment)\b/i
      ],
      confidence: 0.9
    },
    dentist_extraction: {
      patterns: [
        /\b(bunot|tanggal|extract|extraction|bungi|tooth.*remov)\b/i,
        /\b(ngipin)\b.*\b(bunot|tanggal)\b/i
      ],
      confidence: 0.85
    },
    anesthesia: {
      patterns: [
        /\b(anesthesia|pamanhid|injection|needle)\b/i,
        /\b(free|libre|bayad)\b.*\b(anesthesia|pamanhid)\b/i
      ],
      confidence: 0.9
    },
    doctor_schedule: {
      patterns: [
        /\b(doctor|doktor|physician|md)\b.*\b(schedule|available|kelan|kailan|when|time)\b/i,
        /\b(schedule|available|kelan|kailan)\b.*\b(doctor|doktor)\b/i
      ],
      confidence: 0.9
    },
    sick_no_doctor: {
      patterns: [
        /\b(sick|sakit|may.*sakit)\b.*\b(outside|wala|walang|no.*doctor)\b/i,
        /\b(what.*if|paano.*kung)\b.*\b(sick|sakit)\b.*\b(doctor.*not|wala.*doctor)\b/i
      ],
      confidence: 0.85
    },
    emergency: {
      patterns: [
        /\b(emergency|urgent|serious|critical|grabe|matinde)\b/i,
        /\b(accident|injury|sugat|bleeding)\b/i
      ],
      confidence: 0.95
    },
    medical_certificate: {
      patterns: [
        /\b(certificate|medcert|med.*cert|excuse|excuse.*letter)\b/i,
        /\b(medical)\b.*\b(certificate|excuse)\b/i
      ],
      confidence: 0.9
    },
    referral: {
      patterns: [
        /\b(referral|refer|hospital|dongon|pa.?hospital)\b/i,
        /\b(specialist|specialist.*care)\b/i
      ],
      confidence: 0.85
    },
    medicines: {
      patterns: [
        /\b(medicine|gamot|meds|medication|paracetamol|biogesic|drug)\b/i,
        /\b(what.*medicine|available.*medicine|may.*gamot)\b/i
      ],
      confidence: 0.8
    },
    medicine_limit: {
      patterns: [
        /\b(limit|max|gaano|how\s*much|how\s*many|ilan)\b.*\b(medicine|gamot)\b/i,
        /\b(medicine|gamot)\b.*\b(limit|max|ilan)\b/i
      ],
      confidence: 0.85
    },
    parental_consent: {
      patterns: [
        /\b(parent|consent|permission|magulang|pahintulot)\b.*\b(medicine|gamot)\b/i,
        /\b(without.*parent|walang.*magulang)\b/i
      ],
      confidence: 0.9
    },
    medicine_unavailable: {
      patterns: [
        /\b(wala|walang|not.*available|out.*of.*stock)\b.*\b(medicine|gamot)\b/i,
        /\b(medicine|gamot)\b.*\b(wala|not.*available)\b/i
      ],
      confidence: 0.85
    },
    refusal_slip: {
      patterns: [
        /\b(cannot.*accommodate|refusal|full|puno|walang.*slot)\b/i,
        /\b(refusal.*slip|can't.*accommodate)\b/i
      ],
      confidence: 0.85
    },
    services: {
      patterns: [
        /\b(services|service|serbisyo|what.*can|ano.*kaya|what.*do|help.*with)\b/i,
        /\b(first.*aid|basic.*care)\b/i
      ],
      confidence: 0.7
    },
    payment: {
      patterns: [
        /\b(pay|payment|bayad|free|libre|magkano|how.*much|cost|price|fee)\b/i
      ],
      confidence: 0.8
    },
    thanks: {
      patterns: [
        /\b(thank|thanks|salamat|thank.*you|maraming.*salamat)\b/i
      ],
      confidence: 0.95
    },
    help: {
      patterns: [
        /\b(help|tulong|assist|guide|confused|nalilito)\b/i
      ],
      confidence: 0.8
    }
  };

  let bestMatch = { intent: 'unknown', confidence: 0 };

  for (const [intentName, intentData] of Object.entries(intents)) {
    for (const pattern of intentData.patterns) {
      if (pattern.test(text)) {
        if (intentData.confidence > bestMatch.confidence) {
          bestMatch = { intent: intentName, confidence: intentData.confidence };
        }
      }
    }
  }

  // Context-aware intent boosting
  if (session.lastIntent && bestMatch.confidence < 0.9) {
    const contextBoosts = {
      'dentist_schedule': ['dentist_appointment', 'dentist_extraction', 'anesthesia'],
      'medicines': ['medicine_limit', 'parental_consent', 'medicine_unavailable'],
      'doctor_schedule': ['sick_no_doctor', 'emergency']
    };

    if (contextBoosts[session.lastIntent]?.includes(bestMatch.intent)) {
      bestMatch.confidence += 0.1;
    }
  }

  return bestMatch;
}

// Handle incoming messages with enhanced intelligence
function handleMessage(senderId, message) {
  const text = message.text?.trim() || '';
  if (!text) return;

  const session = getUserSession(senderId);
  const lang = detectLanguage(text);
  session.lastLang = lang;

  // Handle follow-up questions
  if (session.waitingFor) {
    handleFollowUp(senderId, text, session);
    return;
  }

  const { intent, confidence } = detectIntent(text, session);
  
  console.log(`Intent: ${intent}, Confidence: ${confidence}, Language: ${lang}`);

  // Route to appropriate handler
  const handlers = {
    greeting: () => sendWelcomeMessage(senderId, lang, session),
    dentist_schedule: () => sendDentistSchedule(senderId, lang, session),
    dentist_appointment: () => sendDentistAppointment(senderId, lang, session),
    dentist_extraction: () => sendDentistExtraction(senderId, lang, session),
    anesthesia: () => sendAnesthesiaInfo(senderId, lang, session),
    doctor_schedule: () => sendDoctorSchedule(senderId, lang, session),
    sick_no_doctor: () => sendSickOutsideSchedule(senderId, lang, session),
    emergency: () => sendEmergencyInfo(senderId, lang, session),
    medical_certificate: () => sendMedicalCertificateInfo(senderId, lang, session),
    referral: () => sendReferralInfo(senderId, lang, session),
    medicines: () => sendAvailableMedicines(senderId, lang, session),
    medicine_limit: () => sendMedicineLimit(senderId, lang, session),
    parental_consent: () => sendParentalConsent(senderId, lang, session),
    medicine_unavailable: () => sendMedicineNotAvailable(senderId, lang, session),
    refusal_slip: () => sendRefusalSlipInfo(senderId, lang, session),
    services: () => sendClinicServices(senderId, lang, session),
    payment: () => sendPaymentInfo(senderId, lang, session),
    thanks: () => sendThanksResponse(senderId, lang, session),
    help: () => sendHelpMessage(senderId, lang, session),
    unknown: () => {
      if (confidence < 0.3) {
        sendClarificationRequest(senderId, lang, text, session);
      } else {
        sendOffTopicResponse(senderId, lang, session);
      }
    }
  };

  const handler = handlers[intent] || handlers.unknown;
  handler();
  
  session.lastIntent = intent;
}

// Handle postbacks
function handlePostback(senderId, postback) {
  const payload = postback.payload;
  const session = getUserSession(senderId);
  const lang = session.lastLang || 'en';

  const handlers = {
    'DENTIST': () => sendDentistSchedule(senderId, lang, session),
    'DOCTOR': () => sendDoctorSchedule(senderId, lang, session),
    'MEDICINES': () => sendAvailableMedicines(senderId, lang, session),
    'REFERRAL': () => sendReferralInfo(senderId, lang, session),
    'CERTIFICATE': () => sendMedicalCertificateInfo(senderId, lang, session),
    'SERVICES': () => sendClinicServices(senderId, lang, session),
    'EMERGENCY': () => sendEmergencyInfo(senderId, lang, session),
    'PAYMENT': () => sendPaymentInfo(senderId, lang, session)
  };

  const handler = handlers[payload] || (() => sendMainMenu(senderId, lang));
  handler();
  
  session.lastIntent = payload.toLowerCase();
}

// Handle follow-up questions
function handleFollowUp(senderId, text, session) {
  const lang = session.lastLang;
  
  if (session.waitingFor === 'dentist_more_info') {
    if (text.match(/\b(appointment|book|schedule|extraction|bunot)\b/i)) {
      sendDentistAppointment(senderId, lang, session);
    } else if (text.match(/\b(anesthesia|pamanhid|free|libre)\b/i)) {
      sendAnesthesiaInfo(senderId, lang, session);
    } else {
      sendMainMenu(senderId, lang);
    }
    session.waitingFor = null;
  }
}

// Enhanced response functions
function sendWelcomeMessage(senderId, lang = 'en', session) {
  const isReturning = session.conversationCount > 1;
  
  const messages = {
    en: isReturning 
      ? `👋 Welcome back! How can I help you today?`
      : `👋 Hi there! Welcome to ${CLINIC_INFO.name} Clinic!\n\nI'm your virtual clinic assistant. I can help you with:\n\n🦷 Dentist schedules & appointments\n👨‍⚕️ Doctor availability\n💊 Medicines & prescriptions\n📋 Medical certificates\n🏥 Hospital referrals\n⚕️ Emergency information\n\nWhat would you like to know?`,
    tl: isReturning
      ? `👋 Kumusta ulit! Ano ang maitutulong ko ngayong araw?`
      : `👋 Kumusta! Maligayang pagdating sa ${CLINIC_INFO.name} Clinic!\n\nAko ang inyong virtual clinic assistant. Maaari kong tulungan kayo sa:\n\n🦷 Schedule at appointment ng dentist\n👨‍⚕️ Availability ng doktor\n💊 Mga gamot at prescription\n📋 Medical certificate\n🏥 Hospital referral\n⚕️ Emergency information\n\nAno ang nais ninyong malaman?`
  };
  
  const response = {
    text: messages[lang],
    quick_replies: [
      {
        content_type: "text",
        title: lang === 'en' ? "🦷 Dentist" : "🦷 Dentista",
        payload: "DENTIST"
      },
      {
        content_type: "text",
        title: lang === 'en' ? "👨‍⚕️ Doctor" : "👨‍⚕️ Doktor",
        payload: "DOCTOR"
      },
      {
        content_type: "text",
        title: lang === 'en' ? "💊 Medicines" : "💊 Gamot",
        payload: "MEDICINES"
      },
      {
        content_type: "text",
        title: lang === 'en' ? "🚨 Emergency" : "🚨 Emergency",
        payload: "EMERGENCY"
      }
    ]
  };
  sendMessage(senderId, response);
}

function sendMainMenu(senderId, lang = 'en') {
  const messages = {
    en: "What else would you like to know?",
    tl: "Ano pa ang nais ninyong malaman?"
  };
  
  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: messages[lang],
        buttons: [
          {
            type: "postback",
            title: lang === 'en' ? "🦷 Dentist Info" : "🦷 Info ng Dentista",
            payload: "DENTIST"
          },
          {
            type: "postback",
            title: lang === 'en' ? "👨‍⚕️ Doctor Info" : "👨‍⚕️ Info ng Doktor",
            payload: "DOCTOR"
          },
          {
            type: "postback",
            title: lang === 'en' ? "💊 Medicines" : "💊 Gamot",
            payload: "MEDICINES"
          }
        ]
      }
    }
  };
  sendMessage(senderId, response);
}

function sendDentistSchedule(senderId, lang = 'en', session) {
  const messages = {
    en: `🦷 *Dentist Schedule*\n\nOur dentist is available every day:\n\n📅 *Monday - Friday*\nMorning: 8:30-11:30 AM (10 slots)\nAfternoon: 1:30-4:30 PM (10 slots)\n\n📅 *Saturday*\n8:00-11:30 AM (half-day)\n\n⚠️ *Important:* You need an appointment. Slots fill up quickly, so book early!`,
    tl: `🦷 *Schedule ng Dentista*\n\nAvailable ang dentista araw-araw:\n\n📅 *Lunes - Biyernes*\nUmaga: 8:30-11:30 AM (10 slots)\nHapon: 1:30-4:30 PM (10 slots)\n\n📅 *Sabado*\n8:00-11:30 AM (half-day)\n\n⚠️ *Importante:* Kailangan ng appointment. Mabilis mapuno ang slots, kaya mag-book ng maaga!`
  };
  
  sendTextMessage(senderId, messages[lang]);
  session.waitingFor = 'dentist_more_info';
  
  setTimeout(() => {
    const followUp = {
      en: "Would you like to know about booking an appointment or tooth extraction procedures?",
      tl: "Gusto ninyong malaman kung paano mag-book ng appointment o ang proseso ng pagbunot ng ngipin?"
    };
    sendTextMessage(senderId, followUp[lang]);
  }, 1500);
}

function sendDentistAppointment(senderId, lang = 'en', session) {
  const messages = {
    en: `📝 *Booking a Dentist Appointment*\n\n✅ Yes, appointments are required\n✅ Walk-ins are accepted if slots are available\n✅ Each time slot has 10 available slots\n\n*For tooth extraction:*\n🦷 You'll receive your referral slip on the same day as your scheduled extraction\n💉 Anesthesia is included (FREE)\n\n💡 Tip: Book your appointment at least a day in advance to secure your slot!`,
    tl: `📝 *Pag-book ng Appointment sa Dentista*\n\n✅ Oo, kailangan ng appointment\n✅ Walk-in ay accepted kung may available slots\n✅ May 10 available slots bawat time slot\n\n*Para sa pagbunot ng ngipin:*\n🦷 Makukuha ninyo ang referral slip sa mismong araw ng scheduled extraction\n💉 Kasama na ang anesthesia (LIBRE)\n\n💡 Tip: Mag-book ng appointment at least isang araw in advance para sigurado ang slot ninyo!`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendDentistExtraction(senderId, lang = 'en', session) {
  const messages = {
    en: `🦷 *Tooth Extraction Information*\n\n*Process:*\n1️⃣ Book an appointment\n2️⃣ Come on your scheduled day\n3️⃣ Dentist will assess your tooth\n4️⃣ Extraction will be performed\n5️⃣ Receive referral slip and aftercare instructions\n\n💉 *Anesthesia:* Included and FREE\n📋 *Referral slip:* Given same day\n⏱️ *Duration:* Usually 30-45 minutes\n\n⚠️ *Bring:* School ID and parental consent (if minor)`,
    tl: `🦷 *Impormasyon sa Pagbunot ng Ngipin*\n\n*Proseso:*\n1️⃣ Mag-book ng appointment\n2️⃣ Pumunta sa scheduled day\n3️⃣ Susuriin ng dentista ang ngipin\n4️⃣ Isasagawa ang extraction\n5️⃣ Makakakuha ng referral slip at aftercare instructions\n\n💉 *Anesthesia:* Kasama na at LIBRE\n📋 *Referral slip:* Ibibigay same day\n⏱️ *Tagal:* Usually 30-45 minuto\n\n⚠️ *Dalhin:* School ID at parental consent (kung minor)`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendAnesthesiaInfo(senderId, lang = 'en', session) {
  const messages = {
    en: `💉 *Anesthesia Information*\n\n✅ *Completely FREE* during tooth removal\n✅ Local anesthesia is used\n✅ Applied by our licensed dentist\n✅ Safe and effective\n\n*What to expect:*\n• Numbing sensation in the area\n• Effect lasts 2-4 hours\n• No pain during extraction\n\n*After effects:*\n• Numbness wears off gradually\n• Mild discomfort is normal\n• Follow aftercare instructions`,
    tl: `💉 *Impormasyon sa Anesthesia*\n\n✅ *Ganap na LIBRE* kapag nagpabunot ng ngipin\n✅ Local anesthesia ang ginagamit\n✅ Inilalagay ng aming licensed dentist\n✅ Ligtas at epektibo\n\n*Ano ang asahan:*\n• Manhid na pakiramdam sa area\n• Tumatagal ng 2-4 oras ang epekto\n• Walang sakit habang binubunot\n\n*Pagkatapos:*\n• Unti-unting nawawala ang pamamanhid\n• Normal ang bahagyang discomfort\n• Sundin ang aftercare instructions`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendDoctorSchedule(senderId, lang = 'en', session) {
  const messages = {
    en: `👨‍⚕️ *Doctor's Schedule*\n\nOur doctor is available:\n\n📅 *Every Tuesday, Wednesday, Thursday*\n⏰ 9:00 AM - 12:00 NN (noon)\n\n*Services include:*\n• General consultation\n• Health assessments\n• Medical certificates\n• Prescription medicines\n• Referrals to specialists\n\n💡 *Can't make it during doctor's hours?*\nYou can still visit for first aid and basic care. For serious cases, we'll refer you to ${CLINIC_INFO.hospital}.`,
    tl: `👨‍⚕️ *Schedule ng Doktor*\n\nAvailable ang doktor:\n\n📅 *Tuwing Martes, Miyerkules, Huwebes*\n⏰ 9:00 AM - 12:00 NN (tanghali)\n\n*Mga serbisyo:*\n• General consultation\n• Health assessment\n• Medical certificate\n• Prescription medicines\n• Referral sa specialist\n\n💡 *Hindi makakadalo during doctor's hours?*\nPwede pa rin kayong bumisita para sa first aid at basic care. Para sa seryosong kaso, ire-refer namin kayo sa ${CLINIC_INFO.hospital}.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendSickOutsideSchedule(senderId, lang = 'en', session) {
  const messages = {
    en: `🏥 *Sick Outside Doctor's Schedule?*\n\n✅ *Don't worry!* Our clinic is here for you.\n\n*We can provide:*\n• First aid treatment\n• Basic care and monitoring\n• Common medicines\n• Emergency assessment\n\n*For serious cases:*\n🏥 We'll provide a referral slip to ${CLINIC_INFO.hospital}\n🚨 For emergencies, you can go directly to the hospital\n\n*Clinic staff are available during regular clinic hours to assist you.*`,
    tl: `🏥 *May Sakit Kahit Wala ang Doktor?*\n\n✅ *Walang problema!* Nandito pa rin ang clinic para sa inyo.\n\n*Mayroon kaming:*\n• First aid treatment\n• Basic care at monitoring\n• Common medicines\n• Emergency assessment\n\n*Para sa seryosong kaso:*\n🏥 Magbibigay kami ng referral slip sa ${CLINIC_INFO.hospital}\n🚨 Para sa emergency, diretso na sa hospital\n\n*May clinic staff na available during regular clinic hours para tumulong sa inyo.*`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendEmergencyInfo(senderId, lang = 'en', session) {
  const messages = {
    en: `🚨 *Emergency Procedures*\n\n*For medical emergencies:*\n\n1️⃣ Come to the clinic immediately (if on campus)\n2️⃣ Clinic staff will assess the situation\n3️⃣ For serious cases:\n   • Immediate referral to ${CLINIC_INFO.hospital}\n   • Emergency contact notification\n\n*You can also:*\n✅ Go directly to ${CLINIC_INFO.hospital}\n✅ Call emergency services (911)\n\n*What qualifies as emergency:*\n• Severe injuries\n• Difficulty breathing\n• Chest pain\n• Severe bleeding\n• Loss of consciousness\n• Allergic reactions\n\n⚠️ *Don't wait - seek help immediately!*`,
    tl: `🚨 *Emergency Procedures*\n\n*Para sa medical emergency:*\n\n1️⃣ Pumunta kaagad sa clinic (kung nasa campus)\n2️⃣ Susuriin ng clinic staff ang sitwasyon\n3️⃣ Para sa seryosong kaso:\n   • Agad na referral sa ${CLINIC_INFO.hospital}\n   • Notification sa emergency contact\n\n*Pwede rin kayong:*\n✅ Diretso sa ${CLINIC_INFO.hospital}\n✅ Tumawag sa emergency services (911)\n\n*Ano ang emergency:*\n• Matinding injury\n• Hirap huminga\n• Chest pain\n• Matinding pagdurugo\n• Pagkawala ng malay\n• Allergic reaction\n\n⚠️ *Huwag maghintay - humingi ng tulong kaagad!*`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendMedicalCertificateInfo(senderId, lang = 'en', session) {
  const messages = {
    en: `📋 *Medical Certificate*\n\n*We issue certificates for:*\n✅ Excuse from school activities\n✅ Class absences due to illness\n✅ Fever or asthma attacks\n✅ Other valid medical reasons\n\n*Requirements:*\n• Must be examined by clinic staff or doctor\n• Valid medical reason confirmed\n• Proper documentation of condition\n\n*Processing:*\n⏱️ Usually issued same day\n📝 Includes diagnosis and recommendations\n🆔 Requires student ID\n\n⚠️ *Note:* Certificates are only issued for legitimate medical reasons verified by our medical staff.`,
    tl: `📋 *Medical Certificate*\n\n*Naglalabas kami ng certificate para sa:*\n✅ Excuse sa school activities\n✅ Absence dahil sa sakit\n✅ Lagnat o asthma attack\n✅ Iba pang valid medical reason\n\n*Requirements:*\n• Dapat suriin ng clinic staff o doctor\n• Kumpirmadong valid medical reason\n• Proper documentation ng condition\n\n*Processing:*\n⏱️ Usually ibinibigay same day\n📝 May kasamang diagnosis at recommendations\n🆔 Kailangan ng student ID\n\n⚠️ *Tandaan:* Certificate ay para lang sa legitimate medical reasons na verified ng medical staff.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendReferralInfo(senderId, lang = 'en', session) {
  const messages = {
    en: `🏥 *Hospital Referral*\n\n*When do you need a referral?*\n• Specialist consultation needed\n• Advanced medical procedures\n• Laboratory tests not available on campus\n• Hospitalization required\n\n*How to get a referral:*\n1️⃣ Visit the school clinic\n2️⃣ Consultation with doctor/clinic staff\n3️⃣ Assessment of your condition\n4️⃣ Receive referral slip to ${CLINIC_INFO.hospital}\n\n*For emergencies:*\n🚨 You can go directly to the hospital without a referral\n\n*Referral benefits:*\n✅ Proper documentation\n✅ Faster processing at hospital\n✅ Medical history included`,
    tl: `🏥 *Hospital Referral*\n\n*Kailan kailangan ng referral?*\n• Kailangan ng specialist consultation\n• Advanced medical procedures\n• Laboratory test na wala sa campus\n• Kailangan ng hospitalization\n\n*Paano makakuha ng referral:*\n1️⃣ Pumunta sa school clinic\n2️⃣ Consultation sa doctor/clinic staff\n3️⃣ Assessment ng inyong condition\n4️⃣ Makakakuha ng referral slip sa ${CLINIC_INFO.hospital}\n\n*Para sa emergency:*\n🚨 Pwede kayong diretso sa hospital nang walang referral\n\n*Benefits ng referral:*\n✅ Proper documentation\n✅ Mas mabilis ang processing sa hospital\n✅ May kasamang medical history`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendAvailableMedicines(senderId, lang = 'en', session) {
  const medicineList = CLINIC_INFO.medicines.map(med => `   • ${med}`).join('\n');
  const messages = {
    en: `💊 *Available Medicines*\n\n*Currently stocked:*\n${medicineList}\n\n*Important information:*\n📋 Maximum 2 medicines per person\n👨‍👩‍👧 Parental consent required (for minors)\n🔍 Allergy check conducted first\n💳 Completely FREE for students\n\n*What if the medicine you need isn't available?*\n🏥 We'll provide a referral to the nearest pharmacy or hospital\n\n💡 *Tip:* Always inform staff of any known allergies or current medications you're taking.`,
    tl: `💊 *Available na Gamot*\n\n*Kasalukuyang available:*\n${medicineList}\n\n*Mahalagang impormasyon:*\n📋 Maximum 2 gamot per tao\n👨‍👩‍👧 Kailangan ng parental consent (para sa minor)\n🔍 Checheck muna kung may allergy\n💳 Ganap na LIBRE para sa estudyante\n\n*Paano kung wala ang kailangan ninyong gamot?*\n🏥 Magbibigay kami ng referral sa pinakamalapit na pharmacy o hospital\n\n💡 *Tip:* Palaging ipaalam sa staff kung may kilalang allergy o kasalukuyang iniinom na gamot.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendMedicineLimit(senderId, lang = 'en', session) {
  const messages = {
    en: `💊 *Medicine Limit Policy*\n\n*Maximum allowance:*\n📋 2 medicines per person per visit\n\n*Why this limit?*\n✅ Ensures fair distribution to all students\n✅ Prevents misuse\n✅ Adequate for most common conditions\n\n*When you need more:*\n• Valid prescription required\n• Doctor's assessment needed\n• May be referred to pharmacy/hospital\n\n*What counts as "one medicine":*\n• One type of medication\n• Example: Paracetamol counts as 1, Loperamide counts as 1\n\n📝 All medicine distribution is documented for your safety.`,
    tl: `💊 *Limitasyon sa Gamot*\n\n*Maximum allowance:*\n📋 2 gamot per tao bawat bisita\n\n*Bakit may limit?*\n✅ Para pantay-pantay ang distribusyon sa lahat\n✅ Iwas sa misuse\n✅ Sapat na para sa karamihan ng common conditions\n\n*Kung kailangan ng higit pa:*\n• Kailangan ng valid prescription\n• Assessment ng doctor\n• Pwedeng ma-refer sa pharmacy/hospital\n\n*Ano ang "isang gamot":*\n• Isang uri ng medication\n• Halimbawa: Paracetamol ay 1, Loperamide ay 1\n\n📝 Lahat ng medicine distribution ay documented para sa inyong kaligtasan.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendParentalConsent(senderId, lang = 'en', session) {
  const messages = {
    en: `👨‍👩‍👧 *Parental Consent Required*\n\n*For students under 18:*\n✅ Parental permission needed before dispensing medicine\n✅ Consent can be:\n   • Written authorization on file\n   • Phone call to parent/guardian\n   • Signed consent form\n\n*Safety checks we perform:*\n🔍 Allergy history verification\n🔍 Current medications check\n🔍 Medical history review\n🔍 Proper dosage calculation\n\n*For students 18 and above:*\n📝 Can provide own consent\n📝 Still subject to safety checks\n\n⚠️ *Your safety is our priority!* These measures protect you from adverse reactions.`,
    tl: `👨‍👩‍👧 *Kailangan ng Pahintulot ng Magulang*\n\n*Para sa estudyante na wala pang 18:*\n✅ Kailangan ng pahintulot ng magulang bago magbigay ng gamot\n✅ Pwedeng:\n   • Written authorization na naka-file\n   • Phone call sa magulang/guardian\n   • Signed consent form\n\n*Safety checks na ginagawa namin:*\n🔍 Verification ng allergy history\n🔍 Check ng current medications\n🔍 Review ng medical history\n🔍 Tamang dosage calculation\n\n*Para sa estudyante 18 pataas:*\n📝 Pwedeng magbigay ng sariling consent\n📝 May safety checks pa rin\n\n⚠️ *Ang inyong kaligtasan ay priority namin!* Ang mga hakbang na ito ay para protektahan kayo sa adverse reactions.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendMedicineNotAvailable(senderId, lang = 'en', session) {
  const messages = {
    en: `💊 *Medicine Not Available*\n\n*What happens if we don't have your medicine?*\n\n✅ You'll receive a referral slip\n✅ Directed to:\n   🏪 Nearest pharmacy, or\n   🏥 ${CLINIC_INFO.hospital}\n\n*The referral includes:*\n📋 Your diagnosis\n📋 Recommended medication\n📋 Proper dosage instructions\n📋 Medical notes from clinic staff\n\n*Alternative options:*\n• We may have a similar medication available\n• Basic treatment can still be provided\n• Pain management while you obtain medicine\n\n💡 *Tip:* Keep the referral slip for proper treatment at the pharmacy or hospital.`,
    tl: `💊 *Walang Available na Gamot*\n\n*Ano ang mangyayari kung wala kaming gamot na kailangan ninyo?*\n\n✅ Makakakuha kayo ng referral slip\n✅ Ide-direct sa:\n   🏪 Pinakamalapit na pharmacy, o\n   🏥 ${CLINIC_INFO.hospital}\n\n*Ang referral ay may kasamang:*\n📋 Inyong diagnosis\n📋 Recommended medication\n📋 Tamang dosage instructions\n📋 Medical notes mula sa clinic staff\n\n*Alternative options:*\n• Mayroon kaming similar medication na available\n• Basic treatment ay pwede pa ring ibigay\n• Pain management habang kumukuha ng gamot\n\n💡 *Tip:* Ingatan ang referral slip para sa tamang treatment sa pharmacy o hospital.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendRefusalSlipInfo(senderId, lang = 'en', session) {
  const messages = {
    en: `📄 *Refusal Slip Information*\n\n*What is a refusal slip?*\nA document given when the clinic cannot accommodate your needs\n\n*Reasons for refusal slip:*\n• All appointment slots are full\n• Condition requires specialized care\n• Equipment/medicine not available\n• Outside clinic's scope of service\n\n*What the slip contains:*\n📋 Reason for refusal\n📋 Your basic information\n📋 Recommended next steps\n📋 Alternative facilities\n\n*With this slip you can:*\n✅ Seek treatment at other facilities\n✅ Explain your situation\n✅ Get expedited service\n\n💡 *Remember:* This is not a denial of care, just a redirection to appropriate services.`,
    tl: `📄 *Refusal Slip*\n\n*Ano ang refusal slip?*\nDokumento na ibinibigay kung hindi kayo ma-accommodate ng clinic\n\n*Dahilan ng refusal slip:*\n• Puno na ang lahat ng appointment slots\n• Kailangan ng specialized care\n• Walang equipment/gamot na available\n• Hindi saklaw ng clinic service\n\n*Laman ng slip:*\n📋 Dahilan ng refusal\n📋 Inyong basic information\n📋 Recommended next steps\n📋 Alternative facilities\n\n*Gamit ng slip:*\n✅ Magpagamot sa ibang facility\n✅ Ipaliwanag ang inyong sitwasyon\n✅ Makakuha ng expedited service\n\n💡 *Tandaan:* Hindi ito denial ng care, redirection lang ito sa appropriate services.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendClinicServices(senderId, lang = 'en', session) {
  const messages = {
    en: `🏥 *Clinic Services*\n\n*Medical Services:*\n👨‍⚕️ Doctor consultation (Tue/Wed/Thu)\n🦷 Dental services (Mon-Sat)\n💊 Medicine dispensing\n🩹 First aid & wound care\n🌡️ Health monitoring\n\n*Documentation Services:*\n📋 Medical certificates\n📄 Referral slips\n📝 Health clearances\n\n*Emergency Services:*\n🚨 Emergency assessment\n🏥 Hospital referrals\n📞 Emergency contact coordination\n\n*Preventive Care:*\n✅ Health education\n✅ Basic health screening\n✅ Wellness advice\n\n💰 *All services are FREE for enrolled students!*`,
    tl: `🏥 *Mga Serbisyo ng Clinic*\n\n*Medical Services:*\n👨‍⚕️ Konsultasyon sa doktor (Tue/Wed/Thu)\n🦷 Dental services (Mon-Sat)\n💊 Pag-dispense ng gamot\n🩹 First aid & wound care\n🌡️ Health monitoring\n\n*Documentation Services:*\n📋 Medical certificate\n📄 Referral slip\n📝 Health clearance\n\n*Emergency Services:*\n🚨 Emergency assessment\n🏥 Hospital referral\n📞 Emergency contact coordination\n\n*Preventive Care:*\n✅ Health education\n✅ Basic health screening\n✅ Wellness advice\n\n💰 *Lahat ng serbisyo ay LIBRE para sa enrolled students!*`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendPaymentInfo(senderId, lang = 'en', session) {
  const messages = {
    en: `💰 *Payment Information*\n\n🎉 *GOOD NEWS!*\n\n✅ ALL basic services are FREE\n✅ Common medicines are FREE\n✅ Dental services are FREE\n✅ Doctor consultations are FREE\n✅ Medical certificates are FREE\n✅ First aid is FREE\n\n*What's included:*\n• Regular check-ups\n• Basic medications\n• Tooth extraction (with free anesthesia)\n• Wound care\n• Health monitoring\n• Emergency care\n\n*No hidden charges!*\n💳 No payment required\n💵 No processing fees\n🆓 Completely free for all enrolled students\n\n📚 *Your tuition covers these health services.*`,
    tl: `💰 *Impormasyon sa Bayad*\n\n🎉 *GOOD NEWS!*\n\n✅ Lahat ng basic services ay LIBRE\n✅ Common medicines ay LIBRE\n✅ Dental services ay LIBRE\n✅ Doctor consultation ay LIBRE\n✅ Medical certificate ay LIBRE\n✅ First aid ay LIBRE\n\n*Kasama sa libre:*\n• Regular check-up\n• Basic medication\n• Pagbunot ng ngipin (libre ang anesthesia)\n• Wound care\n• Health monitoring\n• Emergency care\n\n*Walang hidden charges!*\n💳 Walang bayad\n💵 Walang processing fee\n🆓 Ganap na libre para sa lahat ng enrolled students\n\n📚 *Saklaw ng inyong tuition ang health services na ito.*`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 2000);
}

function sendThanksResponse(senderId, lang = 'en', session) {
  const messages = {
    en: `😊 You're welcome! I'm glad I could help.\n\nIf you have any other questions about the clinic, feel free to ask anytime!\n\nStay healthy! 💚`,
    tl: `😊 Walang anuman! Natutuwa akong nakatulong.\n\nKung may iba pang tanong tungkol sa clinic, huwag mag-atubiling magtanong anumang oras!\n\nIngat lagi! 💚`
  };
  
  sendTextMessage(senderId, messages[lang]);
  
  setTimeout(() => {
    const followUp = {
      en: "Need anything else?",
      tl: "May iba pa ba kayong kailangan?"
    };
    sendTextMessage(senderId, followUp[lang]);
  }, 1500);
}

function sendHelpMessage(senderId, lang = 'en', session) {
  const messages = {
    en: `🤝 *How Can I Help?*\n\nI can answer questions about:\n\n🦷 *Dentist* - schedules, appointments, extractions\n👨‍⚕️ *Doctor* - availability, consultations\n💊 *Medicines* - what's available, limits, consent\n📋 *Certificates* - medical certificates, referrals\n🏥 *Services* - what the clinic offers\n🚨 *Emergencies* - what to do, where to go\n💰 *Payment* - cost information\n\nJust ask me anything, or choose from the menu below!`,
    tl: `🤝 *Paano Ako Makakatulong?*\n\nMasasagot ko ang tanong tungkol sa:\n\n🦷 *Dentista* - schedule, appointment, extraction\n👨‍⚕️ *Doktor* - availability, consultation\n💊 *Gamot* - available, limit, consent\n📋 *Certificate* - medical certificate, referral\n🏥 *Serbisyo* - mga alok ng clinic\n🚨 *Emergency* - ano gagawin, saan pupunta\n💰 *Bayad* - impormasyon sa cost\n\nMagtanong lang, o pumili sa menu sa baba!`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

function sendClarificationRequest(senderId, lang = 'en', text, session) {
  const messages = {
    en: `🤔 I'm not quite sure what you're asking about.\n\nCould you please rephrase your question? You can ask about:\n\n• Dentist schedules or appointments\n• Doctor availability\n• Available medicines\n• Medical certificates\n• Hospital referrals\n• Emergency procedures\n• Clinic services\n\nOr choose from the options below:`,
    tl: `🤔 Hindi ko masyadong maintindihan ang inyong tanong.\n\nPwede ba ninyong ulitin sa ibang paraan? Magtanong tungkol sa:\n\n• Schedule o appointment ng dentista\n• Availability ng doktor\n• Available na gamot\n• Medical certificate\n• Hospital referral\n• Emergency procedure\n• Mga serbisyo ng clinic\n\nO pumili sa mga option sa baba:`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

function sendOffTopicResponse(senderId, lang = 'en', session) {
  const messages = {
    en: `⚠️ I'm specifically designed to help with ${CLINIC_INFO.name} Clinic matters.\n\nI can only answer questions about:\n✅ Clinic services and schedules\n✅ Medical and dental care\n✅ Medicines and prescriptions\n✅ Certificates and referrals\n\nFor other concerns, please contact the appropriate school office.\n\nHow can I help you with clinic-related matters?`,
    tl: `⚠️ Ako ay specifically designed para sa ${CLINIC_INFO.name} Clinic matters.\n\nMasasagot ko lang ang tanong tungkol sa:\n✅ Clinic services at schedule\n✅ Medical at dental care\n✅ Gamot at prescription\n✅ Certificate at referral\n\nPara sa ibang concern, makipag-ugnayan sa appropriate school office.\n\nPaano kita matutulungan sa clinic-related matters?`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Send text message
function sendTextMessage(senderId, text) {
  sendMessage(senderId, { text });
}

// Send message via Messenger API
function sendMessage(senderId, message) {
  axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
    recipient: { id: senderId },
    message: message,
    messaging_type: 'RESPONSE'
  }, {
    params: { access_token: PAGE_ACCESS_TOKEN }
  })
  .then(response => {
    console.log('Message sent successfully');
  })
  .catch(error => {
    console.error('Error sending message:', error.response?.data || error.message);
  });
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Saint Joseph College Clinic Chatbot is running! 🏥');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});