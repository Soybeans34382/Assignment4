const http = require("http");
const path = require("path");
const fs = require("fs");
const { MongoClient, ObjectId } = require("mongodb");
const crypto = require("crypto");
require('dotenv').config();


const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

let productsCollection;
let usersCollection;
const sessions = new Map();

async function connectDB() {
    try {
        await client.connect();
        const db = client.db("focusflow_database");
        productsCollection = db.collection("focusflow_collection");
        usersCollection = db.collection("users");
        console.log("connected to mongodb")
    } catch (e) {
        console.error("MongoDB connection failed:", e);
        process.exit(1);
    }
}


const SESSION_TIMEOUT = 30 * 60 * 1000; //30 mins

function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    
    if (Date.now() - session.time > SESSION_TIMEOUT) {
        sessions.delete(sessionId);
        return null;
    }
    session.time = Date.now();
    return session;
}

function createSession(username) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    sessions.set(sessionId, { username, time: Date.now() });
    return sessionId;
}

function getSessionFromCookie(cookieHeader) {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(';');
    for (let cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'sessionId') return value;
    }
    return null;
}

const server = http.createServer((req, res) => {

    // home page
   if (req.url === '/') {
        const sessionId = getSessionFromCookie(req.headers.cookie);

        if (sessionId && getSession(sessionId)) {
            res.writeHead(302, { 'Location': '/admin' }); //if already logged in
            return res.end();
        }

        fs.readFile(path.join(__dirname,'login.html'),
            (err, content) => {
                if (err) throw err;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            }
        );
    }

    else if (req.url === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { username, password } = JSON.parse(body);
                const user = await usersCollection.findOne({ username, password });
                
                if (user) {
                    const sessionId = createSession(username);
                    res.writeHead(200, { 
                        'Content-Type': 'application/json',
                        'Set-Cookie': `sessionId=${sessionId}; Path=/; HttpOnly`
                    });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid credentials' }));
                }
            } catch (e) {
                res.writeHead(500);
                res.end('Error');
            }
        });
    }

    else if (req.url === '/admin' && req.method === 'GET') {
        const sessionId = getSessionFromCookie(req.headers.cookie);
        if (!sessionId || !getSession(sessionId)) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
            return;
        }
        fs.readFile(path.join(__dirname,'admin.html'),
            (err, content) => {
                if (err) throw err;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            }
        );
    }

    else if (req.url === '/logout' && req.method === 'POST') {
        const sessionId = getSessionFromCookie(req.headers.cookie);
        if (sessionId) {
            sessions.delete(sessionId);
        }
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'sessionId=; Path=/; Max-Age=0'
        });
        res.end(JSON.stringify({ success: true }));
    }

    else if (req.url === '/api' && req.method === 'GET') {
        const sessionId = getSessionFromCookie(req.headers.cookie);
        if (!sessionId || !getSession(sessionId)) { res.writeHead(401); res.end('Unauthorized'); return; }
        productsCollection.find({}).toArray()
            .then(results => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            })
            .catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Failed to fetch products" }));
            });
    }

    else if (req.url === '/api' && req.method === 'POST') {
        const sessionId = getSessionFromCookie(req.headers.cookie);
        if (!sessionId || !getSession(sessionId)) { res.writeHead(401); res.end('Unauthorized'); return; }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const product = JSON.parse(body);
            productsCollection.insertOne(product)
                .then(result => {
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                })
                .catch(err => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Failed to add product" }));
                });
        });
    }

    else if (req.url.startsWith('/api/') && req.method === 'GET') {
        const sessionId = getSessionFromCookie(req.headers.cookie);
        if (!sessionId || !getSession(sessionId)) { res.writeHead(401); res.end('Unauthorized'); return; }
        const id = req.url.split('/')[2];
        productsCollection.findOne({ _id: new ObjectId(id) })
            .then(result => {
                if (!result) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Not found" }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            })
            .catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Failed to fetch product" }));
            });
    }

    else if (req.url.startsWith('/api/') && req.method === 'PUT') {
        const sessionId = getSessionFromCookie(req.headers.cookie);
        if (!sessionId || !getSession(sessionId)) { res.writeHead(401); res.end('Unauthorized'); return; }
        const id = req.url.split('/')[2];
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const updates = JSON.parse(body);
            productsCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: updates }
            )
            .then(result => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            })
            .catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Failed to update product" }));
            });
        });
    }

    else if (req.url.startsWith('/api/') && req.method === 'DELETE') {
        const sessionId = getSessionFromCookie(req.headers.cookie);
        if (!sessionId || !getSession(sessionId)) { res.writeHead(401); res.end('Unauthorized'); return; }
        const id = req.url.split('/')[2];
        productsCollection.deleteOne({ _id: new ObjectId(id) })
            .then(result => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            })
            .catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Failed to delete product" }));
            });
    }
    
    else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end("<h1>404 nothing is here</h1>");
    }
});

const PORT = process.env.PORT || 5959;

connectDB().then(() => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
