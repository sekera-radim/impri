import { describe, it, expect, afterEach } from 'vitest';
import { isPrivateIp, assertPublicUrl } from '../src/net-guard.js';

describe('isPrivateIp', () => {
  it('flags RFC1918 / loopback / link-local IPv4', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1',
      '127.0.0.1', '0.0.0.0', '169.254.169.254', '100.64.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('passes public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 (incl v4-mapped)', () => {
    for (const ip of ['::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('passes public IPv6', () => {
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  afterEach(() => { delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS; });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('javascript:alert(1)')).rejects.toThrow();
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow();
  });

  it('rejects private IP literals', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/x')).rejects.toThrow(/private/i);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private/i);
    await expect(assertPublicUrl('http://[::1]:8484/')).rejects.toThrow(/private/i);
  });

  it('rejects hostnames that resolve to loopback (localhost)', async () => {
    await expect(assertPublicUrl('http://localhost/x')).rejects.toThrow();
  });

  it('allows public IP literals', async () => {
    await expect(assertPublicUrl('https://1.1.1.1/')).resolves.toBeUndefined();
  });

  it('opt-out env bypasses the guard', async () => {
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';
    await expect(assertPublicUrl('http://127.0.0.1/x')).resolves.toBeUndefined();
  });
});
