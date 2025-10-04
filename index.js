const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Configuration - Replace with your actual values
const PAGE_ACCESS_TOKEN = 'EAAh3KOrOCMMBPrvOoJr3nbXLzPzO2S3A7gyF2xXmXIb6yjITDztd5pUgCbzNCBsowzdIK0qcl24ZBjv8DoW5C6kaRq6Tru4K8arYZB8ZCOQAOH2a6ZAuW6wkES4eUm5QGZCk53oyZBYdAvMOSZB48opHj5aNT0Qudf3qx6DpMhJwuPUsMCMvxLlKZBx6GN1Qwj3kDZB5oETl6lLjaKJzOO7NGmgZDZD';
const VERIFY_TOKEN = 'YOUR_VERIFY_TOKEN_HERE'; // Create your own secret string

// Clinic Information - Customize for your school
const CLINIC_INFO = {
  hours: {
    weekdays: '8:00 AM - 5:00 PM',
    saturday: '9:00 AM - 1:00 PM',
    sunday: 'Closed'
  },
  location: 'Main Building, 2nd Floor',
  phone: '(123) 456-7890',
  email: 'clinic@school.edu'
};

// Common health concerns database
const HEALTH_CONCERNS = {
  'fever': 'For fever: Rest, drink plenty of fluids, and take paracetamol if needed. If fever persists for more than 3 days or is over 38.5°C, please visit the clinic.',
  'headache': 'For headaches: Rest in a quiet, dark room. Stay hydrated. If severe or persistent, please visit the clinic.',
  'cold': 'For colds: Rest, drink warm fluids, and get adequate sleep. Visit the clinic if symptoms worsen or persist beyond a week.',
  'stomach': 'For stomach issues: Stay hydrated with clear fluids. Avoid heavy meals. If severe pain or vomiting persists, visit the clinic immediately.',
  'injury': 'For injuries: Apply first aid if minor. For serious injuries, come to the clinic immediately or call emergency services.'
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

  if (text.includes('hello') || text.includes('hi') || text.includes('start')) {
    sendWelcomeMessage(senderId);
  } else if (text.includes('hours') || text.includes('time') || text.includes('open')) {
    sendClinicHours(senderId);
  } else if (text.includes('location') || text.includes('where')) {
    sendClinicLocation(senderId);
  } else if (text.includes('appointment') || text.includes('schedule')) {
    sendAppointmentInfo(senderId);
  } else if (text.includes('emergency')) {
    sendEmergencyInfo(senderId);
  } else if (checkHealthConcern(text)) {
    sendHealthAdvice(senderId, text);
  } else {
    sendMainMenu(senderId);
  }
}

// Handle button postbacks
function handlePostback(senderId, postback) {
  const payload = postback.payload;

  switch(payload) {
    case 'CLINIC_HOURS':
      sendClinicHours(senderId);
      break;
    case 'APPOINTMENT':
      sendAppointmentInfo(senderId);
      break;
    case 'HEALTH_CONCERN':
      sendHealthConcernMenu(senderId);
      break;
    case 'EMERGENCY':
      sendEmergencyInfo(senderId);
      break;
    case 'CONTACT':
      sendContactInfo(senderId);
      break;
    default:
      sendMainMenu(senderId);
  }
}

// Send welcome message with quick replies
function sendWelcomeMessage(senderId) {
  const response = {
    text: "👋 Welcome to our School Clinic! I'm here to help you with:\n\n• Clinic hours and location\n• Scheduling appointments\n• Common health concerns\n• Emergency assistance\n\nHow can I assist you today?",
    quick_replies: [
      {
        content_type: "text",
        title: "📅 Clinic Hours",
        payload: "CLINIC_HOURS"
      },
      {
        content_type: "text",
        title: "📝 Appointment",
        payload: "APPOINTMENT"
      },
      {
        content_type: "text",
        title: "🏥 Health Concern",
        payload: "HEALTH_CONCERN"
      },
      {
        content_type: "text",
        title: "🚨 Emergency",
        payload: "EMERGENCY"
      }
    ]
  };
  sendMessage(senderId, response);
}

// Send main menu with buttons
function sendMainMenu(senderId) {
  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: "How can I help you today?",
        buttons: [
          {
            type: "postback",
            title: "📅 Clinic Hours",
            payload: "CLINIC_HOURS"
          },
          {
            type: "postback",
            title: "📝 Book Appointment",
            payload: "APPOINTMENT"
          },
          {
            type: "postback",
            title: "🏥 Health Concern",
            payload: "HEALTH_CONCERN"
          }
        ]
      }
    }
  };
  sendMessage(senderId, response);
}

// Send clinic hours
function sendClinicHours(senderId) {
  const message = `🕒 *Clinic Hours*\n\n` +
    `Monday - Friday: ${CLINIC_INFO.hours.weekdays}\n` +
    `Saturday: ${CLINIC_INFO.hours.saturday}\n` +
    `Sunday: ${CLINIC_INFO.hours.sunday}\n\n` +
    `📍 Location: ${CLINIC_INFO.location}`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1000);
}

// Send appointment information
function sendAppointmentInfo(senderId) {
  const message = `📝 *Appointment Scheduling*\n\n` +
    `To schedule an appointment:\n\n` +
    `1. Call us: ${CLINIC_INFO.phone}\n` +
    `2. Email: ${CLINIC_INFO.email}\n` +
    `3. Visit us directly during clinic hours\n\n` +
    `Please provide:\n` +
    `• Your name and student ID\n` +
    `• Reason for visit\n` +
    `• Preferred date and time\n\n` +
    `We'll confirm your appointment within 24 hours.`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1000);
}

// Send health concern menu
function sendHealthConcernMenu(senderId) {
  const response = {
    text: "What health concern do you have?",
    quick_replies: [
      {
        content_type: "text",
        title: "🤒 Fever",
        payload: "FEVER"
      },
      {
        content_type: "text",
        title: "🤕 Headache",
        payload: "HEADACHE"
      },
      {
        content_type: "text",
        title: "🤧 Cold/Flu",
        payload: "COLD"
      },
      {
        content_type: "text",
        title: "😖 Stomach Issue",
        payload: "STOMACH"
      },
      {
        content_type: "text",
        title: "🩹 Injury",
        payload: "INJURY"
      }
    ]
  };
  sendMessage(senderId, response);
}

// Check if message contains health concern keywords
function checkHealthConcern(text) {
  return Object.keys(HEALTH_CONCERNS).some(concern => text.includes(concern));
}

// Send health advice based on concern
function sendHealthAdvice(senderId, text) {
  let advice = '';
  for (const [concern, info] of Object.entries(HEALTH_CONCERNS)) {
    if (text.includes(concern)) {
      advice = info;
      break;
    }
  }
  
  const message = `🏥 *Health Advice*\n\n${advice}\n\n` +
    `⚠️ This is general advice only. For proper diagnosis and treatment, ` +
    `please visit the clinic during operating hours.`;
  
  sendTextMessage(senderId, message);
  setTimeout(() => sendMainMenu(senderId), 1000);
}

// Send emergency information
function sendEmergencyInfo(senderId) {
  const message = `🚨 *EMERGENCY*\n\n` +
    `For medical emergencies:\n\n` +
    `1. Call Campus Security: 911 or local emergency number\n` +
    `2. Clinic Emergency Line: ${CLINIC_INFO.phone}\n` +
    `3. Go directly to the nearest hospital\n\n` +
    `For life-threatening situations, call emergency services immediately!\n\n` +
    `The clinic staff will provide first aid and coordinate with emergency services if needed.`;
  
  sendTextMessage(senderId, message);
}

// Send contact information
function sendContactInfo(senderId) {
  const message = `📞 *Contact Information*\n\n` +
    `Phone: ${CLINIC_INFO.phone}\n` +
    `Email: ${CLINIC_INFO.email}\n` +
    `Location: ${CLINIC_INFO.location}\n\n` +
    `Feel free to reach out during clinic hours!`;
  
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
  res.send('School Clinic Chatbot is running! 🏥');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});