const express = require('express');
const bodyParser = require('body-parser');
const Razorpay = require('razorpay');
const shortid = require('shortid');
const crypto = require('crypto');
const cors = require('cors');
const { Configuration, OpenAIApi } = require('openai');
const app = express();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const detectCharacterEncoding = require('detect-character-encoding');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
const atob = require('atob');
const OpenAI = require('openai');
const dotenv = require('dotenv');
dotenv.config();
const openai = new OpenAI(process.env.OPENAI_API_KEY);
const chatHistories = {};
const threadStore = {};
const pdfParse = require('pdf-parse');
const textract = require('textract');


const port = 3000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Set up multer for file handling
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Directory where the file will be saved
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Save the file with its original name
  }
});
const upload = multer({ storage: storage });

const assistantIds = {
    atm_fraud: 'asst_ouENsY02xWT4JowVZf7AwEi3',
    employment_termination: 'asst_rINo5tselv5RqX3ouSSSqKFV'
};

// Pricing for each use case
const pricing = {
    atm_fraud: 99 * 100, // Amount in paise
    employment_termination: 25 * 100 // Amount in paise
};

async function interactWithAssistant(query, orderId) {
    try {
        let threadId;
        
        // If threadId does not exist, create a new thread
        
        if (threadStore[orderId]) {
            threadId = threadStore[orderId];
        } else {
            // If threadId does not exist, create a new thread
            const threadResponse = await openai.beta.threads.create();
            threadId = threadResponse.id;
            // Save the threadId in the store
            threadStore[orderId] = threadId;
        }
        // Add a Message to the Thread
        await openai.beta.threads.messages.create(threadId, {
            role: "user",
            content: query,
        });

        // Run the Assistant
        const runResponse = await openai.beta.threads.runs.create(threadId, {
            assistant_id: 'asst_ouENsY02xWT4JowVZf7AwEi3',
        });

        // Check the Run status and retrieve the response
        let run = await openai.beta.threads.runs.retrieve(threadId, runResponse.id);
        while (run.status !== "completed") {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            run = await openai.beta.threads.runs.retrieve(threadId, runResponse.id);
        }

        // Retrieve the Assistant's Response
        const messagesResponse = await openai.beta.threads.messages.list(threadId);
        const assistantMessages = messagesResponse.data.filter(msg => msg.role === 'assistant');
        const latestAssistantMessage = assistantMessages[0];
        const response = latestAssistantMessage.content
            .filter(contentItem => contentItem.type === 'text')
            .map(textContent => textContent.text.value)
            .join('\n');
        // Store the message in the chat history
        return response;

    } catch (error) {
        console.error("Error interacting with Assistant:", error);
        return "Error: Unable to process the request";
    }
}

const razorpay = new Razorpay({
    key_id: 'rzp_test_KKK315D1Z0fSD7',//rzp_test_3jF4YND4JZ6Gry', //rzp_live_QygxIzCeS0vaNt', //'rzp_test_yJsWzX8ooAwEtl', //'rzp_test_JLg1d3doTMQYyz',
    key_secret: 'idXe5zxzoQo1sJtzD2166daT'//'T4QyBE0mzXfVxbGsEzRr4Z92' //'r3hwIkzBo4T7iN3tt2wDga2Z'
})

app.post('/razorpay', async (req, res) => {
    const { useCase } = req.body;
    const payment_capture = 1;
    const amount = pricing[useCase];
    const currency = 'INR';

    const options = {
        amount: amount, // Amount in paise
        currency,
        receipt: shortid.generate(), // Generates a unique ID for the receipt
        payment_capture
    };

    try {
        const response = await razorpay.orders.create(options);
        console.log('Order Creation Response:', response);

        // Temporarily store the useCase for the order until payment is verified
        threadStore[response.id] = {
            assistantId: null,
            threadId: null,
            useCase: useCase
        };

        res.json({
            id: response.id,
            currency: response.currency,
            amount: response.amount,
            receipt: response.receipt
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/verify', async (req, res) => {
    const secret = 'idXe5zxzoQo1sJtzD2166daT';
    const { order_id, payment_id, signature } = req.body;
    console.log('Request Body:', req.body);

    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(`${order_id}|${payment_id}`);
    const digest = shasum.digest('hex');

    console.log('Digest:', digest);
    console.log('Signature:', signature);

    if (digest === signature) {
        console.log('Payment is legit');

        // Assign the correct assistantId based on the useCase after payment is verified
        threadStore[order_id].assistantId = assistantIds[threadStore[order_id].useCase];

        // Respond with success and redirect to chat
        res.json({ status: 'success', message: 'Payment verified', redirect: '/chat', orderId: order_id });
    } else {
        console.log('Payment verification failed');
        res.status(400).json({ status: 'failure', message: 'Payment verification failed. Please try again.' });
    }
});

function removeAsterisks(text) {
    return text.replace(/\*\*/g, '');
}

app.post('/chat2', upload.single('file'), async (req, res) => {
    const file = req.file;
    const { message, orderId } = req.body;
    console.log(req.body);
    // Check if message and orderId are present in the request body
    if (message && orderId) {
        try {
            let responseMessage = await interactWithAssistant(message, orderId);
            responseMessage  = removeAsterisks(responseMessage );
            res.json({ response: responseMessage });
        } catch (error) {
            console.error('Error interacting with Assistant:', error);
            res.status(500).json({ error: 'Failed to connect to OpenAI' });
        }
    } else if (file) {
        console.log('Received file:', file.originalname);
        console.log('File path:', file.path);

        try {
            let fileText = '';

            if (file.mimetype === 'application/pdf') {
                // Handle PDF files
                const dataBuffer = fs.readFileSync(file.path);
                const data = await pdfParse(dataBuffer);
                fileText = data.text;
            } else {
                // Handle other file types
                textract.fromFileWithPath(file.path, (error, text) => {
                    if (error) {
                        console.error('Error extracting text:', error);
                        res.status(500).json({ error: 'Failed to extract text from file' });
                        return;
                    }
                    fileText = text;
                    res.json({ response: 'File content extracted successfully', fileText });
                });
                return; // Prevent further execution
            }

            // Optionally, do something with the extracted text (e.g., send it to OpenAI)
            console.log('Extracted text:', fileText);
            let filemessage = "Here is the content of employment contract for analysis" + fileText;
            let responseMessage = await interactWithAssistant(filemessage, orderId);
            responseMessage  = removeAsterisks(responseMessage );
            res.json({ response: responseMessage });

        } catch (error) {
            console.error('Error processing file:', error);
            res.status(500).json({ error: 'Failed to process file' });
        }
    } else {
        res.status(400).json({ error: 'No message, orderId, or file uploaded' });
    }
});


// app.post('/chat2', upload.single('file'), async (req, res) => {
//     // req.file contains the uploaded file
//     // req.body contains the other form data
//     console.log(req.body);
//     const file = req.file;
//     const fileContent = req.body.fileContent;
//     const { message, orderId } = req.body;
//     console.log(req.body);
//     console.log(message);
//     console.log(orderId);

//     // Check if message and orderId are present in the request body
//     if (message && orderId) {
//         try {
//             const responseMessage = await interactWithAssistant(message, orderId);
//             res.json({ response: responseMessage });
//         } catch (error) {
//             console.error('Error interacting with Assistant:', error);
//             res.status(500).json({ error: 'Failed to connect to OpenAI' });
//         }
//     } else if (file) {
//         console.log('Received file:', file.originalname);
//         console.log('File path:', file.path);
//         console.log('File content:', fileContent);

//         // Optionally, process the file or save additional information
//         // For example, you might want to do something with the file here

//         res.json({ response: 'File and content received successfully' });
//     } else {
//         res.status(400).json({ error: 'No message, orderId, or file uploaded' });
//     }
// });
  

app.post('/chat', async (req, res) => {
    const { message, orderId } = req.body;
    console.log(req.body);
    console.log(message);
    console.log(orderId);

    try {
        const responseMessage = await interactWithAssistant(message, orderId);

        res.json({ response: responseMessage });
    } catch (error) {
        console.error('Error interacting with Assistant:', error);
        res.status(500).json({ error: 'Failed to connect to OpenAI' });
    }
});

// app.post('/chat', async (req, res) => {
//     try {
//       const { query, orderId } = req.body;
//       if (!query || !orderId) {
//         return res.status(400).json({ error: 'Missing query or orderId' });
//       }
  
//       const threadId = await getThreadId(orderId); // Ensure this function returns a valid threadId
  
//       if (!threadId) {
//         return res.status(500).json({ error: 'Failed to get threadId' });
//       }
  
//       const assistantResponse = await interactWithAssistant(query, threadId);
//       res.json(assistantResponse);
//     } catch (error) {
//       console.error('Error interacting with Assistant:', error);
//       res.status(500).json({ error: 'Internal server error' });
//     }
//   });

app.get('/chat-history/:orderId', (req, res) => {
    const { orderId } = req.params;
    const history = chatHistories[orderId] || [];
    const useCase = threadStore[orderId] ? threadStore[orderId].useCase : '';
    res.json({ messages: history, useCase: useCase });
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});
