import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import minimist from 'minimist';
import { Resend } from 'resend';
import { z } from 'zod';
import packageJson from './package.json' with { type: 'json' };

// --- CONFIG ---
const argv = minimist(process.argv.slice(2));
const apiKey = argv.key || process.env.RESEND_API_KEY;
const senderEmailAddress = argv.sender || process.env.SENDER_EMAIL_ADDRESS;
let replierEmailAddresses: string[] = [];
if (Array.isArray(argv['reply-to'])) replierEmailAddresses = argv['reply-to'];
else if (typeof argv['reply-to'] === 'string') replierEmailAddresses = [argv['reply-to']];
else if (process.env.REPLY_TO_EMAIL_ADDRESSES) replierEmailAddresses = process.env.REPLY_TO_EMAIL_ADDRESSES.split(',');

if (!apiKey) {
  console.error('ERROR: No RESEND_API_KEY found.');
  process.exit(1);
}

const resend = new Resend(apiKey);

// Helper functie om server te maken (nodig per connectie voor SSE stabiliteit)
function createServer() {
  const server = new McpServer({
    name: 'email-sending-service',
    version: packageJson.version,
  });

  server.tool(
    'send-email',
    'Send an email using Resend',
    {
      to: z.string().email(),
      subject: z.string(),
      text: z.string(),
      html: z.string().optional(),
      from: z.string().email().optional(),
      cc: z.string().email().array().optional(),
      bcc: z.string().email().array().optional(),
      replyTo: z.string().email().array().optional(),
      scheduledAt: z.string().optional(),
    },
    async ({ to, subject, text, html, from, cc, bcc, replyTo, scheduledAt }) => {
      const fromEmail = from || senderEmailAddress;
      const replyToEmails = replyTo || replierEmailAddresses;
      
      if (!fromEmail) throw new Error('MISSING_FROM: Sender email is required via arg or env var.');
      
      const response = await resend.emails.send({
        from: fromEmail, to, subject, text, html, 
        cc, bcc, scheduledAt,
        replyTo: replyToEmails.length > 0 ? replyToEmails : undefined
      });
      
      if (response.error) throw new Error(`RESEND_ERROR: ${JSON.stringify(response.error)}`);
      return { content: [{ type: 'text', text: `Email sent! ID: ${response.data?.id}` }] };
    }
  );

  server.tool('list-audiences', 'List Resend audiences', {}, async () => {
    const r = await resend.audiences.list();
    return { content: [{ type: 'text', text: JSON.stringify(r.data) }] };
  });

  return server;
}

async function main() {
  const port = process.env.PORT;

  if (port) {
    // --- HOSTED MODE (Express + CORS) ---
    const app = express();
    
    // Opslag voor actieve transports
    let transport: SSEServerTransport | null = null;
    let serverInstance = createServer();

    // 1. CORS Middleware (Cruciaal voor browser-based apps!)
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    app.get('/sse', async (req, res) => {
      console.log(`--> Nieuwe SSE verbinding van ${req.ip}`);
      transport = new SSEServerTransport('/messages', res);
      serverInstance = createServer(); // Frisse server voor nieuwe klant
      await serverInstance.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      console.log(`--> Bericht ontvangen op /messages`);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).send('No active connection');
      }
    });

    app.listen(port, () => console.log(`MCP Server live on port ${port} with CORS enabled`));
  } else {
    // --- LOCAL MODE ---
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch(console.error);