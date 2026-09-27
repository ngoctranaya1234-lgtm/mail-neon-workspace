import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const pfxFile = resolve('cert.pfx');
if (!existsSync(pfxFile)) {
  console.log('[*] Đang khởi tạo chứng chỉ SSL / TLS (HTTPS) cho localhost...');
  if (process.platform === 'win32') {
    const psScript = [
      "$pwd = ConvertTo-SecureString -String 'workspace-tls' -Force -AsPlainText",
      "$cert = New-SelfSignedCertificate -DnsName 'localhost', '127.0.0.1' -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddYears(5)",
      `Export-PfxCertificate -Cert $cert -FilePath "${pfxFile}" -Password $pwd | Out-Null`,
      "$cert | Remove-Item"
    ].join('; ');
    execSync(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, { stdio: 'inherit' });
    console.log('[✓] Đã tạo chứng chỉ HTTPS thành công: cert.pfx');
  }
}
