<?php
/**
 * mmi-relay.php — Email relay for MMI Cloudflare Worker
 *
 * The Worker cannot connect to Hostinger SMTP directly (Cloudflare IPs are
 * blocked by all major SMTP providers). Instead, the Worker POSTs here and
 * PHP sends the email via PHPMailer + Hostinger SMTP from within the hosting
 * network (always allowed).
 *
 * Security: requests must include the correct shared token.
 * Deploy to: /public_html/mmi-relay.php  (or any web-accessible path)
 */

header('Content-Type: application/json');

// ── Guard: POST only ──────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204); exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']); exit;
}

// ── Secret token — must match RELAY_TOKEN Worker secret ──────────────────────
// Set this to the value you used in: wrangler secret put RELAY_TOKEN
// Do NOT commit the real value — replace the placeholder before deploying.
$RELAY_TOKEN = 'REPLACE_WITH_YOUR_RELAY_TOKEN';

// ── Decode body ───────────────────────────────────────────────────────────────
$data = json_decode(file_get_contents('php://input'), true);
if (!$data || ($data['token'] ?? '') !== $RELAY_TOKEN) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']); exit;
}

$to      = $data['to']      ?? [];   // array of email addresses
$subject = $data['subject'] ?? '';
$html    = $data['html']    ?? '';

if (empty($to) || !$subject || !$html) {
    http_response_code(400);
    echo json_encode(['error' => 'missing fields: to, subject, html']); exit;
}

// ── SMTP config — Hostinger credentials ──────────────────────────────────────
$smtpHost = 'smtp.hostinger.com';
$smtpPort = 587;
$smtpUser = 'alerts@stockmaniacs.net';
$smtpPass = getenv('SMTP_PASSWORD') ?: '';   // set via Hostinger env or hardcode below
// If you don't have server-level env vars on Hostinger, hardcode:
// $smtpPass = 'YOUR_EMAIL_PASSWORD';

if (!$smtpPass) {
    // Fallback: read from a file outside web root (more secure than hardcoding)
    $passFile = dirname(__DIR__) . '/.mmi_smtp_pass';
    if (file_exists($passFile)) {
        $smtpPass = trim(file_get_contents($passFile));
    }
}

if (!$smtpPass) {
    http_response_code(500);
    echo json_encode(['error' => 'SMTP password not configured on server']); exit;
}

// ── Send via PHPMailer (bundled inline below as a class to avoid Composer) ───
// We use a minimal PHP SMTP client using fsockopen — no external dependencies.

try {
    smtpSend([
        'host'    => $smtpHost,
        'port'    => $smtpPort,
        'user'    => $smtpUser,
        'pass'    => $smtpPass,
        'to'      => (array) $to,
        'subject' => $subject,
        'html'    => $html,
    ]);
    echo json_encode(['success' => true, 'to' => implode(', ', (array)$to)]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}

// ── Minimal SMTP client ───────────────────────────────────────────────────────

function smtpSend(array $cfg): void {
    $host    = $cfg['host'];
    $port    = (int)$cfg['port'];   // 587 (STARTTLS)
    $user    = $cfg['user'];
    $pass    = $cfg['pass'];
    $tos     = $cfg['to'];
    $subject = $cfg['subject'];
    $html    = $cfg['html'];

    // Open plain TCP connection on port 587
    $sock = fsockopen($host, $port, $errno, $errstr, 15);
    if (!$sock) throw new Exception("SMTP connect failed: $errstr ($errno)");
    stream_set_timeout($sock, 15);

    $read = function() use ($sock): string {
        $buf = '';
        while (true) {
            $line = fgets($sock, 1024);
            if ($line === false) break;
            $buf .= $line;
            // Last line of a multi-line response has "NNN " (space after code)
            if (strlen($line) >= 4 && $line[3] === ' ') break;
        }
        return $buf;
    };

    $write = function(string $cmd) use ($sock): void {
        fwrite($sock, $cmd . "\r\n");
    };

    $expect = function(string $code) use ($read): string {
        $resp = $read();
        if (substr($resp, 0, 3) !== $code) {
            throw new Exception("Expected $code, got: " . trim($resp));
        }
        return $resp;
    };

    // 1. Greeting
    $expect('220');

    // 2. EHLO
    $write('EHLO mmi-relay');
    $ehlo = $expect('250');

    // 3. STARTTLS
    if (stripos($ehlo, 'STARTTLS') === false) {
        throw new Exception('Server did not advertise STARTTLS');
    }
    $write('STARTTLS');
    $expect('220');

    // 4. Enable TLS on the socket
    if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
        throw new Exception('TLS upgrade failed');
    }

    // 5. Re-EHLO over TLS
    $write('EHLO mmi-relay');
    $expect('250');

    // 6. AUTH LOGIN
    $write('AUTH LOGIN');
    $expect('334');
    $write(base64_encode($user));
    $expect('334');
    $write(base64_encode($pass));
    $expect('235');

    // 7. Envelope
    $write("MAIL FROM:<{$user}>");
    $expect('250');
    foreach ($tos as $addr) {
        $write("RCPT TO:<{$addr}>");
        $expect('250');
    }

    // 8. DATA
    $write('DATA');
    $expect('354');

    // 9. Build RFC 2822 message
    $toHeader = implode(', ', $tos);
    $date     = date('r');    // RFC 2822 date
    $b64Html  = chunk_split(base64_encode($html), 76, "\r\n");
    $encSubj  = '=?UTF-8?B?' . base64_encode($subject) . '?=';

    $message = implode("\r\n", [
        "Date: {$date}",
        "From: StockManiacs Alerts <{$user}>",
        "To: {$toHeader}",
        "Subject: {$encSubj}",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        rtrim($b64Html),
        "",
        ".",
    ]);
    $write($message);
    $expect('250');

    // 10. QUIT
    $write('QUIT');
    fclose($sock);
}
