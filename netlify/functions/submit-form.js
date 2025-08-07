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
    
    // Rimuovi il prefisso internazionale per la colonna NO PREFIX
    let phoneWithoutPrefix = data.phone;
    if (phoneWithoutPrefix.startsWith('+')) {
        // Rimuovi il + e le prime 2 cifre per i prefissi italiani
        if (phoneWithoutPrefix.startsWith('+39')) {
            phoneWithoutPrefix = phoneWithoutPrefix.substring(3);
        } else if (phoneWithoutPrefix.startsWith('+1')) {
            phoneWithoutPrefix = phoneWithoutPrefix.substring(2);
        } else if (phoneWithoutPrefix.startsWith('+44') || phoneWithoutPrefix.startsWith('+33')) {
            phoneWithoutPrefix = phoneWithoutPrefix.substring(3);
        } else if (phoneWithoutPrefix.startsWith('+420') || phoneWithoutPrefix.startsWith('+358')) {
            phoneWithoutPrefix = phoneWithoutPrefix.substring(4);
        } else {
            // Default: assume 2 cifre dopo il +
            phoneWithoutPrefix = phoneWithoutPrefix.substring(3);
        }
    }

    // Mappa delle fonti con nomi più leggibili
    const sourceMap = {
        'mads': 'Meta Ads',
        'igs': 'Instagram', 
        'fb': 'Facebook',
        'google': 'Google Ads',
        'tiktok': 'TikTok',
        'youtube': 'YouTube',
        'yt': 'YouTube',
        'email': 'Email Marketing',
        'sms': 'SMS Marketing',
        'direct': 'Traffico Diretto',
        // Aggiungi altre fonti qui se necessario
    };

    // Usa il nome mappato o il valore originale se non trovato
    const sourceName = sourceMap[data.source] || data.source || 'live-3-agosto';

    // Prepara i dati da inserire secondo le colonne del tuo sheet
    const values = [[
      data.fullName,      // NOME
      data.email,         // EMAIL
      data.phone,         // TELEFONO (con prefisso)
      dataFormattata,     // DATA
      sourceName,         // FONTE (dinamica basata sull'URL)
      phoneWithoutPrefix  // NO PREFIX
    ]];

    // Inserisci i dati
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'A:F', // Inserisce nelle colonne A-F
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    console.log('Salvato su Google Sheets con fonte:', sourceName);
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
    console.error('Errore ottenendo AWeber token:', error.response?.data || error.message);
    throw new Error('Impossibile autenticarsi con AWeber');
  }
}

// Funzione per aggiungere ad AWeber
async function addToAWeber(data) {
  try {
    // Ottieni access token
    const accessToken = await getAWeberAccessToken();

    // Prima verifica se il subscriber esiste già
    console.log('Verifico se il subscriber esiste già...');
    
    const searchResponse = await axios.get(
      `https://api.aweber.com/1.0/accounts/${AWEBER_ACCOUNT_ID}/lists/${AWEBER_LIST_ID}/subscribers`,
      {
        params: { 
          'ws.op': 'find',
          'email': data.email
        },
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    if (searchResponse.data.entries && searchResponse.data.entries.length > 0) {
      // Subscriber esiste già, aggiorna
      console.log('Subscriber esistente trovato, procedo con aggiornamento...');
      const subscriber = searchResponse.data.entries[0];
      
      // Aggiorna i custom fields
      await axios.patch(
        subscriber.self_link,
        {
          name: data.fullName,
          custom_fields: {
            phone: data.phone
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );
      
      // Aggiungi il tag se non esiste già
      const currentTags = subscriber.tags || [];
      if (!currentTags.includes('live-3-agosto')) {
        try {
          await axios.post(
            `${subscriber.self_link}/tags`,
            { 
              name: 'live-3-agosto' 
            },
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              }
            }
          );
          console.log('Tag aggiunto al subscriber esistente');
        } catch (tagError) {
          // Il tag potrebbe già esistere, non è un errore critico
          console.log('Tag potrebbe già esistere:', tagError.response?.data || tagError.message);
        }
      }
      
      console.log('Subscriber esistente aggiornato con successo');
      
    } else {
      // Subscriber non esiste, crea nuovo
      console.log('Nuovo subscriber, procedo con creazione...');
      
      const subscriberData = {
        email: data.email,
        name: data.fullName,
        custom_fields: {
          phone: data.phone
        },
        tags: ['live-3-agosto'],
        strict_custom_fields: false,  // Importante: permette custom fields non definiti
        update_existing: false  // Non tentare di aggiornare automaticamente
      };

      const createResponse = await axios.post(
        `https://api.aweber.com/1.0/accounts/${AWEBER_ACCOUNT_ID}/lists/${AWEBER_LIST_ID}/subscribers`,
        subscriberData,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      console.log('Nuovo subscriber aggiunto ad AWeber con successo');
    }
    
  } catch (error) {
    // Log dettagliato dell'errore
    if (error.response) {
      console.error('Errore AWeber - Status:', error.response.status);
      console.error('Errore AWeber - Data:', JSON.stringify(error.response.data, null, 2));
      console.error('Errore AWeber - Headers:', error.response.headers);
      
      // Se è un errore 403, potrebbe essere un problema di permessi
      if (error.response.status === 403) {
        console.error('ERRORE 403: Verifica che:');
        console.error('1. Il tuo account AWeber abbia i permessi corretti');
        console.error('2. L\'applicazione OAuth2 sia approvata');
        console.error('3. Il refresh token sia valido e non scaduto');
        console.error('4. Il custom field "phone" sia configurato nella lista AWeber');
        
        // Non lanciamo l'errore per non bloccare il salvataggio su Google Sheets
        console.log('Continuando nonostante errore AWeber...');
        return;
      }
      
      // Se è un errore 400 con email già esistente (non dovrebbe più accadere con il nuovo flusso)
      if (error.response.status === 400 && 
          error.response.data?.error?.message?.includes('already subscribed')) {
        console.log('Email già sottoscritta (questo non dovrebbe accadere con il nuovo flusso)');
        return;
      }
    } else {
      console.error('Errore AWeber generale:', error.message);
    }
    
    // Non lanciamo l'errore per non bloccare il salvataggio su Google Sheets
    console.log('Errore con AWeber ma continuo il processo...');
  }
}