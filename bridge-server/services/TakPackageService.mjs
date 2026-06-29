/**
 * TakPackageService
 *
 * Builds an ATAK/iTAK "connection data package" (.zip) from a TAK server's
 * certificates (here, FreeTAKServer's auto-generated certs). The user imports
 * the package into ATAK/iTAK and it auto-configures a TLS server connection —
 * no manual username/password enrollment needed.
 *
 * Uses the system openssl + zip (the bridge runs as root and the certs are
 * world-readable). p12s use SHA1/3DES PBE for maximum TAK/BouncyCastle
 * compatibility.
 */

import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import { readFile, writeFile, mkdir, rm, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const execFile = promisify(execFileCb);

const manifestXml = (name) => `<?xml version="1.0" encoding="UTF-8"?>
<MissionPackageManifest version="2">
   <Configuration>
      <Parameter name="uid" value="MeshBridge-TAK-Connection"/>
      <Parameter name="name" value="${name}.zip"/>
      <Parameter name="onReceiveDelete" value="false"/>
   </Configuration>
   <Contents>
      <Content ignore="false" zipEntry="caCert.p12"/>
      <Content ignore="false" zipEntry="clientCert.p12"/>
      <Content ignore="false" zipEntry="${name}.pref"/>
   </Contents>
</MissionPackageManifest>
`;

const prefXml = (name, host, port, p12pw) => `<?xml version='1.0' encoding='ASCII' standalone='yes'?>
<preferences>
   <preference version="1" name="cot_streams">
      <entry key="count" class="class java.lang.Integer">1</entry>
      <entry key="description0" class="class java.lang.String">${name}</entry>
      <entry key="enabled0" class="class java.lang.Boolean">true</entry>
      <entry key="connectString0" class="class java.lang.String">${host}:${port}:ssl</entry>
      <entry key="caLocation0" class="class java.lang.String">caCert.p12</entry>
      <entry key="caPassword0" class="class java.lang.String">${p12pw}</entry>
      <entry key="certificateLocation0" class="class java.lang.String">clientCert.p12</entry>
      <entry key="clientPassword0" class="class java.lang.String">${p12pw}</entry>
      <entry key="useAuth0" class="class java.lang.Boolean">false</entry>
   </preference>
</preferences>
`;

/**
 * Build the data package and return it as a Buffer.
 * @param {object} opts - { certsPath, host, port, name, p12Password }
 * @returns {Promise<Buffer>} the .zip bytes
 */
export async function buildTakDataPackage(opts) {
  const certsPath = opts.certsPath || '/opt/freetakserver/data/certs';
  const host = opts.host;
  const port = opts.port || 8089;
  const name = (opts.name || 'MeshBridge').replace(/[^A-Za-z0-9_-]/g, '');
  const p12pw = opts.p12Password || 'atakatak';
  const keyPass = opts.keyPass || 'atakatak'; // passphrase on the source client key (TAK Server encrypts it)

  if (!host) throw new Error('host is required');

  // Verify the source certs exist
  for (const f of ['ca.pem', 'Client.pem', 'Client.key']) {
    try { await access(join(certsPath, f)); }
    catch { throw new Error(`TAK certs not found at ${certsPath} (is FreeTAKServer installed?)`); }
  }

  const work = join(tmpdir(), `takpkg-${randomUUID()}`);
  const manifestDir = join(work, 'MANIFEST');
  try {
    await mkdir(manifestDir, { recursive: true });

    const caPem = join(certsPath, 'ca.pem');
    const clientPem = join(certsPath, 'Client.pem');
    const clientKey = join(certsPath, 'Client.key');

    // Compatibility PBE flags (SHA1/3DES) — what ATAK/BouncyCastle expects.
    const pbe = ['-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'];

    // Client cert bundle (cert + key + CA chain). -passin handles an encrypted
    // source key (TAK Server protects client keys; harmless if the key is plaintext).
    await execFile('openssl', [
      'pkcs12', '-export', '-in', clientPem, '-inkey', clientKey, '-passin', `pass:${keyPass}`,
      '-certfile', caPem, '-name', name, '-out', join(work, 'clientCert.p12'),
      '-passout', `pass:${p12pw}`, ...pbe,
    ]);

    // CA truststore (CA cert only, no key)
    await execFile('openssl', [
      'pkcs12', '-export', '-nokeys', '-in', caPem,
      '-name', `${name}-CA`, '-out', join(work, 'caCert.p12'), '-passout', `pass:${p12pw}`, ...pbe,
    ]);

    await writeFile(join(manifestDir, 'manifest.xml'), manifestXml(name));
    await writeFile(join(work, `${name}.pref`), prefXml(name, host, port, p12pw));

    // Zip it (store paths relative to the work dir)
    const zipPath = join(work, `${name}.zip`);
    await execFile('zip', ['-r', '-X', zipPath, 'MANIFEST', 'caCert.p12', 'clientCert.p12', `${name}.pref`], { cwd: work });

    const buf = await readFile(zipPath);
    return buf;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
