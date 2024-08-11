const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const textract = require('textract');
const { Configuration, OpenAIApi } = require('openai');
const dotenv = require('dotenv');

const app = express();
dotenv.config();

const openai = new OpenAIApi(new Configuration({
    apiKey: process.env.OPENAI_API_KEY
}));

const port = 3000;
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
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

const chatHistories = {};
const threadStore = {};

async function interactWithAssistant(query, orderId) {
    try {
        let threadId;

        // If threadId does not exist, create a new thread
        if (threadStore[orderId]) {
            threadId = threadStore[orderId];
        } else {
            // If threadId does not exist, create a new thread
            const threadResponse = await openai.createChatCompletion({
                model: "gpt-3.5-turbo",
                messages: [{ role: "system", content: "You are a helpful assistant." }]
            });
            threadId = threadResponse.data.id;
            // Save the threadId in the store
            threadStore[orderId] = threadId;
        }

        // Add a Message to the Thread
        await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: query }],
            threadId: threadId
        });

        // Retrieve the Assistant's Response
        const messagesResponse = await openai.listChatMessages(threadId);
        const assistantMessages = messagesResponse.data.messages.filter(msg => msg.role === 'assistant');
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

function removeAsterisks(text) {
    return text.replace(/\*\*/g, '');
}

app.post('/chat2', upload.single('file'), async(req, res) => {
    const file = req.file;
    const { message, orderId } = req.body;
    console.log(req.body);

    // Check if message and orderId are present in the request body
    if (message && orderId) {
        try {
            let responseMessage = await interactWithAssistant(message, orderId);
            responseMessage = removeAsterisks(responseMessage);
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
            let fileMessage = "Here is the content of the document for analysis: " + fileText;
            let responseMessage = await interactWithAssistant(fileMessage, orderId);
            responseMessage = removeAsterisks(responseMessage);
            res.json({ response: responseMessage });

        } catch (error) {
            console.error('Error processing file:', error);
            res.status(500).json({ error: 'Failed to process file' });
        }
    } else {
        res.status(400).json({ error: 'No message, orderId, or file uploaded' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
