import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import minimist from 'minimist';
import { Resend } from 'resend';
import { z } from 'zod';
import packageJson from './package.json' with { type: 'json' };

// Parse command line arguments
const argv = minimist(process.argv.slice(2));

// Get API key
const apiKey = argv.key || process.env.RESEND_API_KEY;
const senderEmailAddress = argv.sender || process.env.SENDER_EMAIL_ADDRESS;

// Get reply to email addresses
let replierEmailAddresses: string[] = [];
if (Array.isArray(argv['reply-to'])) {
  replierEmailAddresses = argv['reply-to'];
} else if (typeof argv['reply-to'] === 'string') {
  replierEmailAddresses = [argv['reply-to']];
} else if (process.env.REPLY_TO_EMAIL_ADDRESSES) {
  replierEmailAddresses = process.env.REPLY_TO_EMAIL_ADDRESSES.split(',');
}

if (!apiKey) {
  console.error('No API key provided. Set RESEND_API_KEY.');
  process.exit(1);
}

const resend = new Resend(apiKey);

// Create server instance
const server = new McpServer({
  name: 'email-sending-service',
  version: packageJson.version,
});

server.tool(
  'send-email',
  'Send an email using Resend',
  {
    to: z.string().email().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    text: z.string().describe('Plain text email content'),
    html: z.string().optional().describe('HTML email content. Optional.'),
    cc: z.string().email().array().optional().describe('CC addresses'),
    bcc: z.string().email().array().optional().describe('BCC addresses'),
    scheduledAt: z.string().optional().describe("Natural language scheduling (e.g., 'tomorrow at 10am')"),
    ...(!senderEmailAddress ? {
          from: z.string().email().nonempty().describe('Sender email address (required if not configured env var)'),
        } : {}),
    ...(replierEmailAddresses.length === 0 ? {
          replyTo: z.string().email().array().optional().describe('Reply-to addresses'),
        } : {}),
  },
  async ({ from, to, subject, text, html, replyTo, scheduledAt, cc, bcc }) => {
    const fromEmailAddress = from ?? senderEmailAddress;
    const replyToEmailAddresses = replyTo ?? replierEmailAddresses;

    if (typeof fromEmailAddress !== 'string') throw new Error('from argument missing.');
    
    const emailRequest: any = {
      to, subject, text, from: fromEmailAddress, replyTo: replyToEmailAddresses,
    };
    if (html) emailRequest.html = html;
    if (scheduledAt) emailRequest.scheduledAt = scheduledAt;
    if (cc) emailRequest.cc = cc;
    if (bcc) emailRequest.bcc = bcc;

    console.error(`Sending email to ${to} from ${fromEmailAddress}`);
    const response = await resend.emails.send(emailRequest);

    if (response.error) {
      throw new Error(`Email failed: ${JSON.stringify(response.error)}`);
    }

    return {
      content: [{ type: 'text', text: `Email sent! ID: ${response.data?.id}` }],
    };
  },
);

server.tool(
  'list-audiences',
  'List all audiences from Resend',
  {},
  async () => {
    const response = await resend.audiences.list();
    if (response.error) throw new Error(`Failed to list audiences: ${JSON.stringify(response.error)}`);
    return {
      content: [{ type: 'text', text: `Audiences: ${JSON.stringify(response.data)}` }],
    };
  },
);

async function main() {
  // Detect if we are running on Render (PORT env var is present)
  const port = process.env.PORT;

  if (port) {
    // --- HOSTED MODE (SSE) ---
    const app = express();
    
    // Set up SSE transport
    let transport: SSEServerTransport;

    app.get('/sse', async (req, res) => {
      console.log('New SSE connection');
      transport = new SSEServerTransport('/messages', res);
      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).send('No active connection');
      }
    });

    app.listen(port, () => {
      console.log(`MCP Server is running on port ${port} (SSE Mode)`);
    });
  } else {
    // --- LOCAL MODE (Stdio) ---
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP Server running on stdio');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});