import { writeFileSync } from 'node:fs';
import process from 'node:process';

const pidFile = process.env.MCP_FIXTURE_PID_FILE;
if (pidFile !== undefined) {
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      break;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      handle(JSON.parse(line));
    }
  }
});

function handle(message) {
  if (!Object.hasOwn(message, 'id')) {
    return;
  }
  if (message.method === 'initialize') {
    respond(message.id, {
      capabilities: { tools: {} },
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [
        {
          description: 'Echo JSON through stdio.',
          inputSchema: {
            additionalProperties: false,
            properties: { value: {} },
            required: ['value'],
            type: 'object',
          },
          name: 'echo',
          outputSchema: {
            additionalProperties: false,
            properties: { echo: {} },
            required: ['echo'],
            type: 'object',
          },
        },
      ],
    });
    return;
  }
  if (message.method === 'tools/call') {
    const value = message.params?.arguments?.value;
    respond(message.id, {
      content: [{ text: JSON.stringify(value), type: 'text' }],
      structuredContent: { echo: value },
    });
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ error: { code: -32601, message: 'Method not found' }, id: message.id, jsonrpc: '2.0' })}\n`,
  );
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, jsonrpc: '2.0', result })}\n`);
}
