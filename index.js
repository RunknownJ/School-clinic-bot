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

// Detect if user is speaking Tagalog
function isTagalog(text) {
  const tagalogWords = [
    'kumusta', 'kamusta', 'ako', 'ikaw', 'siya', 'kami', 'tayo', 'kayo', 'sila',
    'ang', 'ng', 'mga', 'sa', 'ay', 'ko', 'mo', 'niya', 'natin', 'namin',
    'kelan', 'kailan', 'saan', 'ano', 'sino', 'paano', 'bakit',
    'oo', 'hindi', 'wala', 'may', 'meron', 'kailangan', 'gusto', 'pwede',
    'magkano', 'libre', 'bayad', 'araw', 'oras', 'bukas', 'ngayon',
    'ngipin', 'gamot', 'sakit', 'doktor', 'ospital', 'clinic', 'klinika',
    'magandang', 'umaga', 'hapon', 'gabi', 'salamat', 'pasensya',
    'po', 'pumunta', 'humingi', 'nakumpirma', 'maitutulong', 'tanong',
    'bunot', 'pamanhid', 'magulang', 'pahintulot', 'estudyante'
  ];
  
  const lowerText = text.toLowerCase();
  return tagalogWords.some(word => lowerText.includes(word));
}

// Handle incoming messages
function handleMessage(senderId, message) {
  const text = message.text?.toLowerCase() || '';
  const lang = isTagalog(text) ? 'tl' : 'en';

  // Check for greetings (must be early to catch simple "hi")
  if (text.match(/\b(hi|hello|hey|kumusta|kamusta|magandang|start|ola|good morning|good afternoon)\b/) && 
      text.length < 50) {
    sendWelcomeMessage(senderId, lang);
  }
  // Medical certificate (check early before other patterns)
  else if (text.includes('certificate') || text.includes('medcert') || text.includes('med cert') ||
           text.match(/\b(excuse|excuse letter|medical cert)\b/)) {
    sendMedicalCertificateInfo(senderId, lang);
  }
  // Dentist-related questions
  else if (text.match(/\b(dentist|ngipin|tooth|teeth|bungi|dental|extraction|tanggal|bunot)\b/)) {
    if (text.match(/\b(schedule|available|open|kelan|kailan|oras|time|sked)\b/)) {
      sendDentistSchedule(senderId, lang);
    } else if (text.match(/\b(appointment|book|mag.?book|kailangan|need|pa.?appointment)\b/)) {
      sendDentistAppointment(senderId, lang);
    } else if (text.match(/\b(anesthesia|pamanhid|injection|free|bayad|libre)\b/)) {
      sendAnesthesiaInfo(senderId, lang);
    } else {
      sendDentistSchedule(senderId, lang);
    }
  }
  // Doctor-related questions
  else if (text.match(/\b(doctor|doktor|physician|md)\b/)) {
    sendDoctorSchedule(senderId, lang);
  }
  // Sick outside doctor schedule
  else if (text.match(/\b(sick|sakit|may sakit)\b/) && text.match(/\b(outside|wala|walang|schedule|doctor|doktor)\b/)) {
    sendSickOutsideSchedule(senderId, lang);
  }
  // Referral questions
  else if (text.match(/\b(referral|refer|hospital|dongon|pa.?hospital)\b/)) {
    sendReferralInfo(senderId, lang);
  }
  // Medicine questions
  else if (text.match(/\b(medicine|gamot|meds|medication|paracetamol|biogesic)\b/)) {
    if (text.match(/\b(limit|max|gaano|how much|how many|ilan)\b/)) {
      sendMedicineLimit(senderId, lang);
    } else if (text.match(/\b(parent|consent|permission|magulang|pahintulot)\b/)) {
      sendParentalConsent(senderId, lang);
    } else if (text.match(/\b(wala|walang|not available|out of stock)\b/)) {
      sendMedicineNotAvailable(senderId, lang);
    } else {
      sendAvailableMedicines(senderId, lang);
    }
  }
  // Refusal slip
  else if (text.match(/\b(cannot accommodate|refusal|full|puno|walang slot)\b/)) {
    sendRefusalSlipInfo(senderId, lang);
  }
  // Services
  else if (text.match(/\b(services|first aid|service|ano|what|serbisyo|tulong)\b/)) {
    sendClinicServices(senderId, lang);
  }
  // Payment/Free
  else if (text.match(/\b(pay|payment|bayad|free|libre|magkano|how much|price)\b/)) {
    sendPaymentInfo(senderId, lang);
  }
  // Show main menu for clinic-related but unclear queries
  else if (text.match(/\b(clinic|klinika|health|kalusugan)\b/)) {
    sendMainMenu(senderId, lang);
  }
  // Non-clinic related questions
  else {
    sendOffTopicResponse(senderId, lang);
  }
}

// Handle button postbacks
function handlePostback(senderId, postback) {
  const payload = postback.payload;
  // Default to English for postbacks since we can't detect language from button clicks
  const lang = 'en';

  switch(payload) {
    case 'DENTIST':
      sendDentistSchedule(senderId, lang);
      break;
    case 'DOCTOR':
      sendDoctorSchedule(senderId, lang);
      break;
    case 'MEDICINES':
      sendAvailableMedicines(senderId, lang);
      break;
    case 'REFERRAL':
      sendReferralInfo(senderId, lang);
      break;
    case 'CERTIFICATE':
      sendMedicalCertificateInfo(senderId, lang);
      break;
    case 'SERVICES':
      sendClinicServices(senderId, lang);
      break;
    default:
      sendMainMenu(senderId, lang);
  }
}

// Welcome message
function sendWelcomeMessage(senderId, lang = 'en') {
  const messages = {
    en: `👋 Welcome to ${CLINIC_INFO.name} Clinic!\n\nI can help you with:\n\n🦷 Dentist schedule\n👨‍⚕️ Doctor schedule\n💊 Available medicines\n📋 Medical certificates\n🏥 Hospital referrals\n\nHow can I help you?`,
    tl: `👋 Kumusta! Maligayang pagdating sa ${CLINIC_INFO.name} Clinic!\n\nMaaari kong tulungan kayo sa:\n\n🦷 Schedule ng dentist\n👨‍⚕️ Schedule ng doktor\n💊 Available na gamot\n📋 Medical certificate\n🏥 Hospital referral\n\nAno ang maitutulong ko sa inyo?`
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
        title: lang === 'en' ? "🏥 Services" : "🏥 Serbisyo",
        payload: "SERVICES"
      }
    ]
  };
  sendMessage(senderId, response);
}

// Main menu
function sendMainMenu(senderId, lang = 'en') {
  const messages = {
    en: "What do you need to know?",
    tl: "Ano ang kailangan ninyong malaman?"
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
            title: lang === 'en' ? "🦷 Dentist Schedule" : "🦷 Schedule ng Dentista",
            payload: "DENTIST"
          },
          {
            type: "postback",
            title: lang === 'en' ? "👨‍⚕️ Doctor Schedule" : "👨‍⚕️ Schedule ng Doktor",
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

// Dentist schedule
function sendDentistSchedule(senderId, lang = 'en') {
  const messages = {
    en: `🦷 *Dentist Schedule*\n\nThe dentist is available every day:\n\n📅 ${CLINIC_INFO.dentist.weekdays}\n📅 ${CLINIC_INFO.dentist.saturday}`,
    tl: `🦷 *Schedule ng Dentista*\n\nAvailable ang dentista araw-araw:\n\n📅 ${CLINIC_INFO.dentist.weekdays}\n📅 ${CLINIC_INFO.dentist.saturday}`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Dentist appointment
function sendDentistAppointment(senderId, lang = 'en') {
  const messages = {
    en: `📝 *Dentist Appointment*\n\nYes, you need an appointment to see the dentist.\n\n*For tooth extraction:* You will get your referral slip on the same day of your scheduled extraction.`,
    tl: `📝 *Appointment sa Dentista*\n\nOo, kailangan ng appointment para makita ang dentista.\n\n*Para sa pagbunot ng ngipin:* Makukuha ninyo ang referral slip sa araw mismo ng inyong scheduled extraction.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Anesthesia info
function sendAnesthesiaInfo(senderId, lang = 'en') {
  const messages = {
    en: `💉 *Anesthesia Information*\n\nYes, anesthesia is FREE of charge during tooth removal.`,
    tl: `💉 *Impormasyon sa Anesthesia*\n\nOo, LIBRE ang anesthesia (pamanhid) kapag nagpabunot ng ngipin.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Doctor schedule
function sendDoctorSchedule(senderId, lang = 'en') {
  const messages = {
    en: `👨‍⚕️ *Doctor Schedule*\n\nThe doctor is available:\n📅 ${CLINIC_INFO.doctor.schedule}`,
    tl: `👨‍⚕️ *Schedule ng Doktor*\n\nAvailable ang doktor:\n📅 ${CLINIC_INFO.doctor.schedule}`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Sick outside doctor schedule
function sendSickOutsideSchedule(senderId, lang = 'en') {
  const messages = {
    en: `🏥 *Sick Outside Doctor's Schedule?*\n\nDon't worry! You may still come to the clinic for:\n✅ Basic care\n✅ First aid\n\nFor serious cases, we will refer you to ${CLINIC_INFO.hospital}.`,
    tl: `🏥 *May Sakit Kahit Wala ang Doktor?*\n\nWalang problema! Pwede pa rin kayong pumunta sa clinic para sa:\n✅ Basic care\n✅ First aid\n\nKung seryoso ang kaso, ire-refer namin kayo sa ${CLINIC_INFO.hospital}.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Referral information
function sendReferralInfo(senderId, lang = 'en') {
  const messages = {
    en: `🏥 *Hospital Referral*\n\nYes, you can request a referral slip if you want to be treated in a hospital like ${CLINIC_INFO.hospital}.\n\n*For emergencies:* You can go directly to the hospital.\n*For regular treatment:* Visit the school clinic first and request a referral.`,
    tl: `🏥 *Referral sa Hospital*\n\nOo, pwede kayong humingi ng referral slip kung gusto ninyong magpatingin sa hospital tulad ng ${CLINIC_INFO.hospital}.\n\n*Para sa emergency:* Diretso na kayo sa hospital.\n*Para sa regular treatment:* Pumunta muna sa school clinic at humingi ng referral.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Medical certificate
function sendMedicalCertificateInfo(senderId, lang = 'en') {
  const messages = {
    en: `📋 *Medical Certificate*\n\nYes, we issue medical certificates if you:\n\n• Need an excuse from school activities\n• Miss class due to fever or asthma attacks\n\n*Note:* Certificates are only issued for valid medical reasons confirmed by the clinic staff.`,
    tl: `📋 *Medical Certificate*\n\nOo, naglalabas kami ng medical certificate kung:\n\n• Kailangan ng excuse sa school activities\n• Hindi pumasok dahil sa lagnat o asthma attack\n\n*Tandaan:* Ang certificate ay para lang sa valid medical reasons na nakumpirma ng clinic staff.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Available medicines
function sendAvailableMedicines(senderId, lang = 'en') {
  const medicineList = CLINIC_INFO.medicines.join('\n• ');
  const messages = {
    en: `💊 *Available Medicines*\n\nWe provide the following medicines:\n\n• ${medicineList}`,
    tl: `💊 *Available na Gamot*\n\nAng mga sumusunod na gamot ay available sa clinic:\n\n• ${medicineList}`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Medicine limit
function sendMedicineLimit(senderId, lang = 'en') {
  const messages = {
    en: `💊 *Medicine Limit*\n\nMaximum of 2 medicines per person if there's a valid prescription.`,
    tl: `💊 *Limitasyon sa Gamot*\n\nMaximum 2 gamot lang per tao kung may valid prescription.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Parental consent
function sendParentalConsent(senderId, lang = 'en') {
  const messages = {
    en: `👨‍👩‍👧 *Parental Consent Required*\n\nWe need parental permission before giving medicines.\n\nWe also check for allergies first to ensure safety.`,
    tl: `👨‍👩‍👧 *Kailangan ng Pahintulot ng Magulang*\n\nKailangan namin ng pahintulot ng magulang bago magbigay ng gamot.\n\nChinecheck din namin kung may allergy para sigurado.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Medicine not available
function sendMedicineNotAvailable(senderId, lang = 'en') {
  const messages = {
    en: `💊 *Medicine Not Available*\n\nIf we don't have the medicine you need, you will be referred to the nearest pharmacy or hospital for complete medication.`,
    tl: `💊 *Walang Available na Gamot*\n\nKung wala kaming gamot na kailangan ninyo, ire-refer namin kayo sa pinakamalapit na pharmacy o hospital.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Refusal slip
function sendRefusalSlipInfo(senderId, lang = 'en') {
  const messages = {
    en: `📄 *Refusal Slip*\n\nIf the clinic cannot accommodate you, you will be given a refusal slip so you can seek treatment outside.`,
    tl: `📄 *Refusal Slip*\n\nKung hindi kayo ma-accommodate sa clinic, bibigyan namin kayo ng refusal slip para makapagpagamot sa labas.`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Clinic services
function sendClinicServices(senderId, lang = 'en') {
  const messages = {
    en: `🏥 *Clinic Services*\n\nWe provide:\n\n✅ First aid\n✅ Basic medicines\n✅ Health monitoring\n✅ Medical certificates\n✅ Referrals to specialists or hospitals\n✅ Dental services\n✅ Doctor consultation`,
    tl: `🏥 *Mga Serbisyo ng Clinic*\n\nNag-aalok kami ng:\n\n✅ First aid\n✅ Basic na gamot\n✅ Health monitoring\n✅ Medical certificate\n✅ Referral sa specialist o hospital\n✅ Dental services\n✅ Konsultasyon sa doktor`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Payment information
function sendPaymentInfo(senderId, lang = 'en') {
  const messages = {
    en: `💰 *Payment Information*\n\nBasic services and common medicines are FREE for students.\n\nNo payment required! 🎉`,
    tl: `💰 *Impormasyon sa Bayad*\n\nLIBRE ang basic services at common medicines para sa mga estudyante.\n\nWalang bayad! 🎉`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1500);
}

// Off-topic response
function sendOffTopicResponse(senderId, lang = 'en') {
  const messages = {
    en: `⚠️ I'm sorry, but I can only answer questions related to the ${CLINIC_INFO.name} Clinic.\n\nPlease ask about:\n• Dentist schedule\n• Doctor schedule\n• Medicines\n• Medical certificates\n• Hospital referrals\n• Clinic services`,
    tl: `⚠️ Pasensya na, pero tanong lang po tungkol sa ${CLINIC_INFO.name} Clinic ang masasagot ko.\n\nPaki-tanong lang tungkol sa:\n• Schedule ng dentista\n• Schedule ng doktor\n• Gamot\n• Medical certificate\n• Hospital referral\n• Mga serbisyo ng clinic`
  };
  
  sendTextMessage(senderId, messages[lang]);
  setTimeout(() => sendMainMenu(senderId, lang), 1000);
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