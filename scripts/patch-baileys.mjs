import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("@chaeulso/baileys/package.json");
const packageRoot = path.dirname(packageJsonPath);

function replaceOnce(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count === 0 && source.includes(label)) return source;
  if (count !== 1) {
    throw new Error(`Baileys patch ${label}: expected one match, found ${count}`);
  }
  return source.replace(search, replacement);
}

async function patchFile(relativePath, transform) {
  const filePath = path.join(packageRoot, relativePath);
  const before = await fs.readFile(filePath, "utf8");
  const after = transform(before);
  if (after !== before) await fs.writeFile(filePath, after, "utf8");
}

await patchFile("lib/Socket/socket.js", (original) => {
  let source = original;

  source = replaceOnce(
    source,
    "        if (!creds.me) {",
    "        // ENCONTRE MAIS PATCH: keep pending phone pairing in registration mode.\n        if (!creds.me || (!!creds.pairingCode && !creds.registered)) {",
    "ENCONTRE MAIS PATCH: keep pending phone pairing in registration mode."
  );

  source = replaceOnce(
    source,
    "                await waitForHandshake();",
    "                await waitForHandshake();\n                // ENCONTRE MAIS PATCH: stop the QR timer when switching to phone-code pairing.\n                clearTimeout(qrTimer);\n                qrTimer = undefined;",
    "ENCONTRE MAIS PATCH: stop QR timer when phone pairing starts"
  );

  const oldStart = "                authState.creds.pairingCode = pairingCode;";
  const oldEndText = "                return authState.creds.pairingCode;";
  const start = source.indexOf(oldStart);
  if (start >= 0 && !source.includes("ENCONTRE MAIS PATCH: acknowledged phone pairing")) {
    const end = source.indexOf(oldEndText, start);
    if (end < 0) throw new Error("Baileys patch: pairing return block not found");
    const endExclusive = end + oldEndText.length;
    const replacement = `                // ENCONTRE MAIS PATCH: acknowledged phone pairing; never show a locally minted, rejected code.
                const me = {
                    id: jidEncode(normalized, 's.whatsapp.net'),
                    name: '~'
                };
                const registration = await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'link_code_companion_reg',
                            attrs: {
                                jid: me.id,
                                stage: 'companion_hello',
                                should_show_push_notification: 'true'
                            },
                            content: [
                                {
                                    tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
                                    attrs: {},
                                    content: await generatePairingKey(pairingCode)
                                },
                                {
                                    tag: 'companion_server_auth_key_pub',
                                    attrs: {},
                                    content: authState.creds.noiseKey.public
                                },
                                {
                                    tag: 'companion_platform_id',
                                    attrs: {},
                                    content: getCompanionPlatformId(browser)
                                },
                                {
                                    tag: 'companion_platform_display',
                                    attrs: {},
                                    content: 'Chrome (Mac OS)'
                                },
                                {
                                    tag: 'link_code_pairing_nonce',
                                    attrs: {},
                                    content: Buffer.alloc(1)
                                }
                            ]
                        }
                    ]
                });
                if (!registration) {
                    throw new Boom('Companion registration timed out', {
                        statusCode: DisconnectReason.timedOut
                    });
                }
                authState.creds.pairingCode = pairingCode;
                authState.creds.me = me;
                pairingProvisional = true;
                ev.emit('creds.update', authState.creds);
                return pairingCode;`;
    source = source.slice(0, start) + replacement + source.slice(endExclusive);
  } else if (!source.includes("ENCONTRE MAIS PATCH: acknowledged phone pairing")) {
    throw new Error("Baileys patch: pairing registration block not found");
  }

  source = replaceOnce(
    source,
    "    async function generatePairingKey() {",
    "    // ENCONTRE MAIS PATCH: derive key from request-local code.\n    async function generatePairingKey(pairingCode) {",
    "ENCONTRE MAIS PATCH: pairing key argument"
  );
  source = replaceOnce(
    source,
    "derivePairingCodeKey(authState.creds.pairingCode, salt)",
    "derivePairingCodeKey(pairingCode, salt) /* ENCONTRE MAIS PATCH: isolated pairing key */",
    "ENCONTRE MAIS PATCH: isolated pairing key"
  );

  return source;
});

await patchFile("lib/Socket/messages-recv.js", (original) => {
  let source = original;
  source = replaceOnce(
    source,
    "            case 'link_code_companion_reg':\n                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');",
    "            case 'link_code_companion_reg': {\n                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');\n                // ENCONTRE MAIS PATCH: ignore the companion_hello response; only primary_hello carries the phone's keys.\n                if (linkCodeCompanionReg?.attrs?.stage !== 'primary_hello') break;",
    "ENCONTRE MAIS PATCH: pairing notification stage guard"
  );
  source = replaceOnce(
    source,
    "                break;\n            case 'privacy_token':",
    "                break;\n            }\n            case 'privacy_token':",
    "ENCONTRE MAIS PATCH: close pairing switch scope"
  );
  return source;
});

console.log("Baileys pairing patches applied and verified.");
