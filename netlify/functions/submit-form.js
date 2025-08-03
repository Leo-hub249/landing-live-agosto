// netlify/functions/submit-form.js

const { google } = require('googleapis');
const axios = require('axios');

// AWeber OAuth2 - Devi ottenere questi valori dal tuo account AWeber Developer
const AWEBER_CLIENT_ID = process.env.AWEBER_CLIENT_ID;
const AWEBER_CLIENT_SECRET = process.env.AWEBER_CLIENT_SECRET;
const AWEBER_REFRESH_TOKEN = process.env.AWEBER_REFRESH_TOKEN;
const AWEBER_ACCOUNT_ID = process.env.AWEBER_ACCOUNT_ID;
const AWEBER_LIST_ID = process.env.AWEBER_LIST_ID;

// Google Sheets - Devi configurare un Service Account
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

exports.handler = async (event, context) => {
  // Permetti solo POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    const data = JSON.parse(event.body);
    
    // Valida i dati
    if (!data.fullName || !data.email || !data.phone) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Tutti i campi sono obbligatori' })
      };
    }

    // 1. Salva su Google Sheets
    await saveToGoogleSheets(data);
    
    // 2. Aggiungi ad AWeber con tag
    await addToAWeber(data);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        message: 'Registrazione completata con successo' 
      })
    };

  } catch (error) {
    console.error('Errore:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Si è verificato un errore durante la registrazione',
        details: error.message 
      })
    };
  }
};

// Funzione per salvare su Google Sheets
async function saveToGoogleSheets(data) {
  try {
    // Configura l'autenticazione
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    const sheets = google.sheets({ version: 'v4', auth });

    // Formatta la data in formato italiano
    const now = new Date();
    const dataFormattata = now.toLocaleDateString('it-IT') + ' ' + now.toLocaleTimeString('it-IT');
    
    // Rimuovi il prefisso dal numero di telefono per la colonna NO PREFIX
    const phoneWithoutPrefix = data.phone.replace(/^\+\d+/, '');

    // Prepara i dati da inserire secondo le colonne del tuo sheet
    const values = [[
      data.fullName,      // NOME
      data.email,         // EMAIL
      data.phone,         // TELEFONO (con prefisso)
      dataFormattata,     // DATA
      'live-3-agosto',    // FONTE
      phoneWithoutPrefix  // NO PREFIX
    ]];

    // Inserisci i dati
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'A:F', // Inserisce nelle colonne A-F
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    console.log('Salvato su Google Sheets');
  } catch (error) {
    console.error('Errore Google Sheets:', error);
    throw new Error('Impossibile salvare su Google Sheets');
  }
}

// Funzione per ottenere Access Token AWeber
async function getAWeberAccessToken() {
  try {
    const response = await axios.post('https://auth.aweber.com/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: AWEBER_REFRESH_TOKEN,
      client_id: AWEBER_CLIENT_ID,
      client_secret: AWEBER_CLIENT_SECRET
    });

    return response.data.access_token;
  } catch (error) {
    console.error('Errore ottenendo AWeber token:', error);
    throw new Error('Impossibile autenticarsi con AWeber');
  }
}

// Funzione per aggiungere ad AWeber
async function addToAWeber(data) {
  try {
    // Ottieni access token
    const accessToken = await getAWeberAccessToken();

    // Prepara i dati del subscriber
    const subscriberData = {
      email: data.email,
      name: data.fullName,
      custom_fields: {
        phone: data.phone
      },
      tags: ['live-3-agosto'],
      update_existing: true // Aggiorna se esiste già
    };

    // Aggiungi il subscriber
    const response = await axios.post(
      `https://api.aweber.com/1.0/accounts/${AWEBER_ACCOUNT_ID}/lists/${AWEBER_LIST_ID}/subscribers`,
      subscriberData,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Aggiunto ad AWeber con successo');
    
  } catch (error) {
    // Se l'email esiste già, aggiorna il subscriber e aggiungi il tag
    if (error.response && error.response.status === 400 && error.response.data.error.message.includes('already subscribed')) {
      console.log('Email già esistente, aggiorno il subscriber...');
      
      try {
        const accessToken = await getAWeberAccessToken();
        
        // Cerca il subscriber esistente
        const searchResponse = await axios.get(
          `https://api.aweber.com/1.0/accounts/${AWEBER_ACCOUNT_ID}/lists/${AWEBER_LIST_ID}/subscribers`,
          {
            params: { 
              'email': data.email,
              'ws.op': 'find'
            },
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (searchResponse.data.entries && searchResponse.data.entries.length > 0) {
          const subscriber = searchResponse.data.entries[0];
          const subscriberId = subscriber.id;
          
          // Aggiorna i custom fields
          await axios.patch(
            subscriber.self_link,
            {
              custom_fields: {
                phone: data.phone
              }
            },
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          // Aggiungi il tag
          await axios.post(
            `${subscriber.self_link}/tags`,
            { 
              name: 'live-3-agosto' 
            },
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          console.log('Subscriber esistente aggiornato con successo');
        }
      } catch (updateError) {
        console.error('Errore durante aggiornamento subscriber:', updateError.response?.data || updateError);
        // Non lanciamo l'errore per non bloccare il processo
      }
    } else {
      console.error('Errore AWeber:', error.response?.data || error.message);
      throw new Error('Impossibile aggiungere ad AWeber');
    }
  }
}