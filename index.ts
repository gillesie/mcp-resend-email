import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import minimist from 'minimist';
import { Resend } from 'resend';
import { z } from 'zod';
import packageJson from './package.json' with { type: 'json' };

// --- CONFIGURATIE ---
const argv = minimist(process.argv.slice(2));
const apiKey = argv.key || process.env.RESEND_API_KEY;
const senderEmailAddress = argv.sender || process.env.SENDER_EMAIL_ADDRESS;

// Reply-to logica (standaard leeg array)
let replierEmailAddresses: string[] = [];
if (Array.isArray(argv['reply-to'])) replierEmailAddresses = argv['reply-to'];
else if (typeof argv['reply-to'] === 'string') replierEmailAddresses = [argv['reply-to']];
else if (process.env.REPLY_TO_EMAIL_ADDRESSES) replierEmailAddresses = process.env.REPLY_TO_EMAIL_ADDRESSES.split(',');

if (!apiKey) {
  console.error('No API key provided. Set RESEND_API_KEY.');
  process.exit(1);
}

const resend = new Resend(apiKey);
const server = new McpServer({
  name: 'email-sending-service',
  version: packageJson.version,
});

// --- TOOLS DEFINIËREN ---
server.tool(
  'send-email',
  'Send an email using Resend',
  {
    // We maken alle velden hier expliciet (en optioneel), dat voorkomt de TS error.
    to: z.string().email().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    text: z.string().describe('Plain text email content'),
    html: z.string().optional().describe('HTML email content'),
    cc: z.string().email().array().optional(),
    bcc: z.string().email().array().optional(),
    scheduledAt: z.string().optional(),
    from: z.string().email().optional().describe('Sender email address (overrides env var)'),
    replyTo: z.string().email().array().optional().describe('Reply-to addresses (overrides env var)'),
  },
  async ({ from, to, subject, text, html, replyTo, scheduledAt, cc, bcc }) => {
    // Logica: Gebruik input argument, anders fallback naar env var.
    const fromEmail = from || senderEmailAddress;
    const replyToEmails = replyTo || replierEmailAddresses;
    
    // Validatie achteraf (in plaats van in het schema)
    if (!fromEmail) {
      throw new Error('From address is missing. Please provide it as argument or set SENDER_EMAIL_ADDRESS env var.');
    }

    // Expliciet type-casten om TS gerust te stellen
    const finalReplyTo: string[] | undefined = replyToEmails.length > 0 ? replyToEmails : undefined;

    const response = await resend.emails.send({
      from: fromEmail, 
      to, 
      subject, 
      text, 
      html, 
      replyTo: finalReplyTo,
      cc, 
      bcc, 
      scheduledAt: scheduledAt 
    });

    if (response.error) throw new Error(`Failed: ${JSON.stringify(response.error)}`);
    return { content: [{ type: 'text', text: `Sent! ID: ${response.data?.id}` }] };
  }
);

server.tool('list-audiences', 'List Resend audiences', {}, async () => {
  const r = await resend.audiences.list();
  return { content: [{ type: 'text', text: JSON.stringify(r.data) }] };
});

// --- SERVER OPSTARTEN ---
async function main() {
  const port = process.env.PORT; 

  if (port) {
    // Render / Web Mode
    const app = express();
    let transport: SSEServerTransport;

    app.get('/sse', async (req, res) => {
      console.log('SSE verbinding gestart');
      transport = new SSEServerTransport('/messages', res);
      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      if (transport) await transport.handlePostMessage(req, res);
    });

    app.listen(port, () => console.log(`Listening on port ${port}`));
  } else {
    // Local CLI Mode
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch(console.error);