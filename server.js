const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://your-frontend-app.vercel.app' // Replace with your actual frontend URL
  ],
  credentials: true
}));
app.use(express.json());

// M-Pesa Configuration from environment variables
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE,
  lipaNaMpesaOnlinePasskey: process.env.MPESA_PASSKEY,
  callbackUrl: process.env.MPESA_CALLBACK_URL || `${process.env.VERCEL_URL}/api/mpesa/callback`
};

// In-memory store (in production, use a database)
const transactions = new Map();

// Base64 encoding function
function base64Encode(str) {
  return Buffer.from(str).toString('base64');
}

// Generate password for STK Push
function generatePassword() {
  const now = new Date();
  const timestamp = 
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  
  const passwordString = `${MPESA_CONFIG.shortcode}${MPESA_CONFIG.lipaNaMpesaOnlinePasskey}${timestamp}`;
  const password = base64Encode(passwordString);
  
  return { password, timestamp };
}

// Get access token
async function getAccessToken() {
  try {
    const credentials = `${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`;
    const auth = base64Encode(credentials);
    
    const response = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    console.error('Access token error:', error.response?.data || error.message);
    throw error;
  }
}

// API Routes

// Health check
app.get('/api', (req, res) => {
  res.json({ 
    status: 'Backend is running on Vercel', 
    timestamp: new Date(),
    environment: process.env.NODE_ENV
  });
});

// STK Push endpoint
app.post('/api/mpesa/stk-push', async (req, res) => {
  try {
    const { phone, amount, accountRef } = req.body;
    
    // Validate input
    if (!phone || !amount || !accountRef) {
      return res.status(400).json({
        success: false,
        error: 'Phone, amount, and account reference are required'
      });
    }

    // Format phone number
    let formattedPhone = phone.trim();
    if (formattedPhone.startsWith('0')) {
      formattedPhone = `254${formattedPhone.slice(1)}`;
    } else if (formattedPhone.startsWith('+254')) {
      formattedPhone = formattedPhone.slice(1);
    } else if (!formattedPhone.startsWith('254')) {
      formattedPhone = `254${formattedPhone}`;
    }

    const accessToken = await getAccessToken();
    const { password, timestamp } = generatePassword();

    const stkPushPayload = {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: parseInt(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: accountRef.substring(0, 12),
      TransactionDesc: 'Payment for goods/services'
    };

    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkPushPayload,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const transactionId = response.data.CheckoutRequestID;
    transactions.set(transactionId, {
      phone: formattedPhone,
      amount: parseInt(amount),
      accountRef,
      status: 'pending',
      createdAt: new Date(),
      customerMessage: response.data.CustomerMessage
    });
    
    res.json({
      success: true,
      message: 'STK Push initiated successfully',
      checkoutRequestId: transactionId,
      customerMessage: response.data.CustomerMessage
    });
    
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate payment',
      details: error.response?.data || error.message
    });
  }
});

// Callback endpoint
app.post('/api/mpesa/callback', (req, res) => {
  try {
    const callbackData = req.body;
    console.log('M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));
    
    if (callbackData.Body && callbackData.Body.stkCallback) {
      const stkCallback = callbackData.Body.stkCallback;
      const checkoutRequestId = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;
      
      if (transactions.has(checkoutRequestId)) {
        const transaction = transactions.get(checkoutRequestId);
        
        if (resultCode === 0) {
          transaction.status = 'completed';
          transaction.completedAt = new Date();
          
          if (stkCallback.CallbackMetadata && stkCallback.CallbackMetadata.Item) {
            stkCallback.CallbackMetadata.Item.forEach(item => {
              if (item.Name === 'Amount') transaction.actualAmount = item.Value;
              if (item.Name === 'MpesaReceiptNumber') transaction.receiptNumber = item.Value;
              if (item.Name === 'TransactionDate') transaction.transactionDate = item.Value;
              if (item.Name === 'PhoneNumber') transaction.payerPhone = item.Value;
            });
          }
        } else {
          transaction.status = 'failed';
          transaction.errorMessage = stkCallback.ResultDesc;
        }
        
        transactions.set(checkoutRequestId, transaction);
      }
    }
    
    res.json({
      ResultCode: 0,
      ResultDesc: "Success"
    });
    
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Failed"
    });
  }
});

// Get transaction status
app.get('/api/transactions/:checkoutRequestId', (req, res) => {
  const { checkoutRequestId } = req.params;
  const transaction = transactions.get(checkoutRequestId);
  
  if (!transaction) {
    return res.status(404).json({ 
      success: false,
      error: 'Transaction not found' 
    });
  }
  
  res.json({
    success: true,
    transaction
  });
});

// Debug endpoint
app.get('/api/debug/config', (req, res) => {
  res.json({
    success: true,
    config: {
      hasConsumerKey: !!MPESA_CONFIG.consumerKey,
      hasConsumerSecret: !!MPESA_CONFIG.consumerSecret,
      hasShortcode: !!MPESA_CONFIG.shortcode,
      hasPasskey: !!MPESA_CONFIG.lipaNaMpesaOnlinePasskey,
      callbackUrl: MPESA_CONFIG.callbackUrl,
      environment: process.env.NODE_ENV
    }
  });
});

app.use("/", (req,res) => {
    res.status(200).json({message:"app is running well"})
})

// Export the app as a serverless function
module.exports = app;