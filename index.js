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

// Handle incoming messages
function handleMessage(senderId, message) {
  const text = message.text?.toLowerCase() || '';

  // Check for greetings (must be early to catch simple "hi")
  if (text.match(/\b(hi|hello|hey|kumusta|kamusta|magandang|start|ola|good morning|good afternoon)\b/) && 
      text.length < 50) {
    sendWelcomeMessage(senderId);
  }
  // Medical certificate (check early before other patterns)
  else if (text.includes('certificate') || text.includes('medcert') || text.includes('med cert') ||
           text.match(/\b(excuse|excuse letter|medical cert)\b/)) {
    sendMedicalCertificateInfo(senderId);
  }
  // Dentist-related questions
  else if (text.match(/\b(dentist|ngipin|tooth|teeth|bungi|dental|extraction|tanggal|bunot)\b/)) {
    if (text.match(/\b(schedule|available|open|kelan|kailan|oras|time|sked)\b/)) {
      sendDentistSchedule(senderId);
    } else if (text.match(/\b(appointment|book|mag.?book|kailangan|need|pa.?appointment)\b/)) {
      sendDentistAppointment(senderId);
    } else if (text.match(/\b(anesthesia|pamanhid|injection|free|bayad|libre)\b/)) {
      sendAnesthesiaInfo(senderId);
    } else {
      sendDentistSchedule(senderId);
    }
  }
  // Doctor-related questions
  else if (text.match(/\b(doctor|doktor|physician|md)\b/)) {
    sendDoctorSchedule(senderId);
  }
  // Sick outside doctor schedule
  else if (text.match(/\b(sick|sakit|may sakit)\b/) && text.match(/\b(outside|wala|walang|schedule|doctor|doktor)\b/)) {
    sendSickOutsideSchedule(senderId);
  }
  // Referral questions
  else if (text.match(/\b(referral|refer|hospital|dongon|pa.?hospital)\b/)) {
    sendReferralInfo(senderId);
  }
  // Medicine questions
  else if (text.match(/\b(medicine|gamot|meds|medication|paracetamol|biogesic)\b/)) {
    if (text.match(/\b(limit|max|gaano|how much|how many|ilan)\b/)) {
      sendMedicineLimit(senderId);
    } else if (text.match(/\b(parent|consent|permission|magulang|pahintulot)\b/)) {
      sendParentalConsent(senderId);
    } else if (text.match(/\b(wala|walang|not available|out of stock)\b/)) {
      sendMedicineNotAvailable(senderId);
    } else {
      sendAvailableMedicines(senderId);
    }
  }
  // Refusal slip
  else if (text.match(/\b(cannot accommodate|refusal|full|puno|walang slot)\b/)) {
    sendRefusalSlipInfo(senderId);
  }
  // Services
  else if (text.match(/\b(services|first aid|service|ano|what|serbisyo|tulong)\b/)) {
    sendClinicServices(senderId);
  }
  // Payment/Free
  else if (text.match(/\b(pay|payment|bayad|free|libre|magkano|how much|price)\b/)) {
    sendPaymentInfo(senderId);
  }
  // Show main menu for clinic-related but unclear queries
  else if (text.match(/\b(clinic|klinika|health|kalusugan)\b/)) {
    sendMainMenu(senderId);
  }
  // Non-clinic related questions
  else {
    sendOffTopicResponse(senderId);
  }
}

// Handle button postbacks
function handlePostback(senderId, postback) {
  const payload = postback.payload;

  switch(payload) {
    case 'DENTIST':
      sendDentistSchedule(senderId);
      break;
    case 'DOCTOR':
      sendDoctorSchedule(senderId);
      break;
    case 'MEDICINES':
      sendAvailableMedicines(senderId);
      break;
    case 'REFERRAL':
      sendReferralInfo(senderId);
      break;
    case 'CERTIFICATE':
      sendMedicalCertificateInfo(senderId);
      break;
    case 'SERVICES':
      sendClinicServices(senderId);
      break;
    default:
      sendMainMenu(senderId);
  }
}

// Welcome message
function sendWelcomeMessage(senderId) {
  const response = {
    text: `👋 Kumusta! Welcome to ${CLINIC_INFO.name} Clinic!\n\nMaaari kong tulungan kayo sa:\n\n🦷 Dentist schedule\n👨‍⚕️ Doctor schedule\n💊 Available medicines\n📋 Medical certificates\n🏥 Hospital referrals\n\nAno ang maitutulong ko sa inyo? / How can I help you?`,
    quick_replies: [
      {
        content_type: "text",
        title: "🦷 Dentist",
        payload: "DENTIST"
      },
      {
        content_type: "text",
        title: "👨‍⚕️ Doctor",
        payload: "DOCTOR"
      },
      {
        content_type: "text",
        title: "💊 Medicines",
        payload: "MEDICINES"
      },
      {
        content_type: "text",
        title: "🏥 Services",
        payload: "SERVICES"
      }
    ]
  };
  sendMessage(senderId, response);
}

// Main menu
function sendMainMenu(senderId) {
  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: "Ano ang kailangan ninyong malaman? / What do you need to know?",
        buttons: [
          {
            type: "postback",
            title: "🦷 Dentist Schedule",
            payload: "DENTIST"
          },
          {
            type: "postback",
            title: "👨‍⚕️ Doctor Schedule",
            payload: "DOCTOR"
          },
          {
            type: "postback",
            title: "💊 Medicines",
            payload: "MEDICINES"
          }
        ]
      }
    }
  };
  sendMessage(senderId, response);
}

// Dentist schedule
function sendDentistSchedule(senderId) {
  const message = `🦷 *Dentist Schedule*\n\n` +
    `The dentist is available every day:\n\n` +
    `📅 ${CLINIC_INFO.dentist.weekdays}\n` +
    `📅 ${CLINIC_INFO.dentist.saturday}\n\n` +
    `*Available ang dentist araw-araw!*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Dentist appointment
function sendDentistAppointment(senderId) {
  const message = `📝 *Dentist Appointment*\n\n` +
    `✅ Yes, you need an appointment to see the dentist.\n\n` +
    `*For tooth extraction:* You will get your referral slip on the same day of your scheduled extraction.\n\n` +
    `*Oo, kailangan ng appointment. Kung magpabunot ng ngipin, makukuha ang referral slip sa araw mismo ng extraction.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Anesthesia info
function sendAnesthesiaInfo(senderId) {
  const message = `💉 *Anesthesia Information*\n\n` +
    `✅ Yes, anesthesia is FREE of charge during tooth removal.\n\n` +
    `*Libre ang pamanhid (anesthesia) kapag nagpabunot ng ngipin!*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Doctor schedule
function sendDoctorSchedule(senderId) {
  const message = `👨‍⚕️ *Doctor Schedule*\n\n` +
    `The doctor is available:\n` +
    `📅 ${CLINIC_INFO.doctor.schedule}\n\n` +
    `*Available ang doctor tuwing Tuesday, Wednesday, at Thursday morning lang.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Sick outside doctor schedule
function sendSickOutsideSchedule(senderId) {
  const message = `🏥 *Sick Outside Doctor's Schedule?*\n\n` +
    `Don't worry! You may still come to the clinic for:\n` +
    `✅ Basic care\n` +
    `✅ First aid\n\n` +
    `For serious cases, we will refer you to ${CLINIC_INFO.hospital}.\n\n` +
    `*Pwede pa rin kayong pumunta sa clinic para sa basic care. Kung seryoso, ire-refer kayo sa Dongon Hospital.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Referral information
function sendReferralInfo(senderId) {
  const message = `🏥 *Hospital Referral*\n\n` +
    `✅ Yes, you can request a referral slip if you want to be treated in a hospital like ${CLINIC_INFO.hospital}.\n\n` +
    `*For emergencies:* You can go directly to the hospital.\n` +
    `*For regular treatment:* Visit the school clinic first and request a referral.\n\n` +
    `*Pwede kayong humingi ng referral slip kung gusto ninyong magpatingin sa hospital. Pero sa emergency, diretso na sa hospital!*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Medical certificate
function sendMedicalCertificateInfo(senderId) {
  const message = `📋 *Medical Certificate*\n\n` +
    `✅ Yes, we issue medical certificates if you:\n\n` +
    `• Need an excuse from school activities\n` +
    `• Miss class due to fever or asthma attacks\n\n` +
    `*Note:* Certificates are only issued for valid medical reasons confirmed by the clinic staff.\n\n` +
    `*Naglalabas kami ng medical certificate para sa valid medical reasons na nakumpirma ng clinic.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Available medicines
function sendAvailableMedicines(senderId) {
  const medicineList = CLINIC_INFO.medicines.join('\n• ');
  const message = `💊 *Available Medicines*\n\n` +
    `We provide the following medicines:\n\n• ${medicineList}\n\n` +
    `*Ito ang mga gamot na available sa clinic.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Medicine limit
function sendMedicineLimit(senderId) {
  const message = `💊 *Medicine Limit*\n\n` +
    `Maximum of 2 medicines per person if there's a valid prescription.\n\n` +
    `*Maximum 2 gamot lang per tao kung may valid prescription.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Parental consent
function sendParentalConsent(senderId) {
  const message = `👨‍👩‍👧 *Parental Consent Required*\n\n` +
    `We need parental permission before giving medicines.\n\n` +
    `We also check for allergies first to ensure safety.\n\n` +
    `*Kailangan ng pahintulot ng magulang bago magbigay ng gamot. Chinecheck din namin kung may allergy.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Medicine not available
function sendMedicineNotAvailable(senderId) {
  const message = `💊 *Medicine Not Available*\n\n` +
    `If we don't have the medicine you need, you will be referred to the nearest pharmacy or hospital for complete medication.\n\n` +
    `*Kung wala kaming gamot na kailangan ninyo, ire-refer kayo sa pharmacy o hospital.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Refusal slip
function sendRefusalSlipInfo(senderId) {
  const message = `📄 *Refusal Slip*\n\n` +
    `If the clinic cannot accommodate you, you will be given a refusal slip so you can seek treatment outside.\n\n` +
    `*Kung hindi kayo ma-accommodate sa clinic, bibigyan kayo ng refusal slip para makapagpagamot sa labas.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Clinic services
function sendClinicServices(senderId) {
  const message = `🏥 *Clinic Services*\n\n` +
    `We provide:\n\n` +
    `✅ First aid\n` +
    `✅ Basic medicines\n` +
    `✅ Health monitoring\n` +
    `✅ Medical certificates\n` +
    `✅ Referrals to specialists or hospitals\n` +
    `✅ Dental services\n` +
    `✅ Doctor consultation\n\n` +
    `*Nag-aalok kami ng first aid, gamot, medical certificate, at referral sa hospital kung kailangan.*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Payment information
function sendPaymentInfo(senderId) {
  const message = `💰 *Payment Information*\n\n` +
    `✅ Basic services and common medicines are FREE for students.\n\n` +
    `No payment required! 🎉\n\n` +
    `*LIBRE ang basic services at common medicines para sa mga estudyante!*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1500);
}

// Off-topic response
function sendOffTopicResponse(senderId) {
  const message = `⚠️ I'm sorry, but I can only answer questions related to the ${CLINIC_INFO.name} Clinic.\n\n` +
    `Please ask about:\n` +
    `• Dentist schedule\n` +
    `• Doctor schedule\n` +
    `• Medicines\n` +
    `• Medical certificates\n` +
    `• Hospital referrals\n` +
    `• Clinic services\n\n` +
    `*Pasensya na, pero tanong lang po tungkol sa clinic ang masasagot ko. Salamat!*`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1000);
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