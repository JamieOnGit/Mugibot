// Sign up, log in, log out, password reset, account settings. Accounts are a
// username and a password; an email address is optional (for password
// resets and email alerts). A connected Discord account can also receive
// password-reset links by DM.

import { dummyVerify, hashPassword, verifyPassword } from '../crypto.js';
import { cookie } from '../http.js';
import { STARTER_ITEMS } from '../presets.js';
import { HttpError, bad, item as checkItem, optionalEmail, password as checkPassword, str, username as checkUsername } from '../schema.js';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

export function sessionCookieName(cfg) {
  return cfg.secureCookies ? '__Host-mgb_session' : 'mgb_session';
}

export function startSession(ctx, req, user) {
  const token = ctx.repo.createSession(user.id, req.headers['user-agent'] || '');
  req.setCookie(cookie(sessionCookieName(ctx.cfg), token, { maxAge: ctx.cfg.sessionDays * 24 * 60 * 60, secure: ctx.cfg.secureCookies }));
  ctx.repo.updateUser(user.id, { last_login_at: ctx.repo.now() });
}

function clearSession(ctx, req) {
  req.setCookie(cookie(sessionCookieName(ctx.cfg), '', { maxAge: 0, secure: ctx.cfg.secureCookies }));
}

export function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email || '', name: u.name, role: u.role, createdAt: u.created_at, discord: u.discord_username || null };
}

export function seedStarterList(ctx, userId) {
  const { repo, retailers } = ctx;
  for (const p of STARTER_ITEMS) {
    if (repo.countItems(userId) >= ctx.cfg.limits.items) break;
    if (repo.itemBySku(userId, 'kmart', p.sku)) continue;
    repo.addItem(userId, checkItem(p, { retailers }));
  }
}

/** Send a password-reset link by email and/or Discord DM. Returns how many were sent. */
export async function sendResetLink(ctx, user) {
  const token = ctx.repo.createReset(user.id);
  const link = `${ctx.cfg.baseUrl}/reset?token=${token}`;
  const text = `Someone (hopefully you) asked to reset the password for the ${ctx.cfg.appName} account "${user.username}".\n\nChoose a new password here (the link works for 1 hour):\n${link}\n\nIf it wasn't you, ignore this — your password hasn't changed.`;
  let sent = 0;
  if (user.email && ctx.mailer.configured) {
    if (await ctx.mailer.send({ to: user.email, subject: `Reset your ${ctx.cfg.appName} password`, text })) sent += 1;
  }
  if (user.discord_id && ctx.discord.botReady) {
    const ok = await ctx.discord.dm(user, { embeds: [{ title: `Reset your ${ctx.cfg.appName} password`, description: text, color: 0x2563eb }] }).catch(() => false);
    if (ok) sent += 1;
  }
  return { sent, link };
}

export function register(router, ctx) {
  const { cfg, repo, limiter } = ctx;

  router.post('/api/auth/signup', async (req) => {
    if (!cfg.signupsOpen) throw new HttpError(403, 'Sign-ups are closed at the moment');
    if (!limiter.hit(`signup:${req.ip}`, cfg.limits.signupsPerHour, 60 * MIN)) throw new HttpError(429, 'Too many sign-ups from your network — try again later');
    const username = checkUsername(req.body.username);
    const password = checkPassword(req.body.password);
    const email = optionalEmail(req.body.email);
    if (!req.body.acceptTerms) throw bad('Please accept the Terms of Service and Privacy Policy');
    if (repo.userByUsername(username)) throw new HttpError(409, 'That username is taken — choose another');
    if (email && repo.userByEmail(email)) throw new HttpError(409, 'That email is already used by another account');
    const trial = cfg.trialDays > 0;
    const user = repo.createUser({
      username,
      email,
      name: str(req.body.name, 80),
      passwordHash: await hashPassword(password),
      role: cfg.adminUsernames.includes(username) ? 'admin' : 'user',
      plan: trial ? 'trial' : 'none',
      trialEndsAt: trial ? repo.now() + cfg.trialDays * DAY : null,
    });
    seedStarterList(ctx, user.id);
    repo.addEvent(user.id, {
      type: 'account', level: 'success',
      message: trial ? `Welcome to ${cfg.appName}! Your ${cfg.trialDays}-day free trial has started.` : `Welcome to ${cfg.appName}! Start your membership under Membership to switch on monitoring and ⚡ Buy.`,
    });
    startSession(ctx, req, user);
    return { user: publicUser(user) };
  }, { auth: 'none' });

  router.post('/api/auth/login', async (req) => {
    const name = str(req.body.username, 60).toLowerCase();
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    if (limiter.peek(`login-ip:${req.ip}`) >= 30 || limiter.peek(`login-user:${name}`) >= 10) {
      throw new HttpError(429, 'Too many attempts — wait 15 minutes, or reset your password');
    }
    // Username, or the email address on the account.
    const user = repo.userByUsername(name) || (name.includes('@') ? repo.userByEmail(name) : null);
    const ok = user ? await verifyPassword(pw, user.password_hash) : await dummyVerify(pw);
    if (!ok || !user) {
      limiter.hit(`login-ip:${req.ip}`, 30, 15 * MIN);
      limiter.hit(`login-user:${name}`, 10, 15 * MIN);
      throw new HttpError(401, 'Wrong username or password');
    }
    if (user.disabled) throw new HttpError(403, 'This account has been suspended — contact support');
    limiter.clear(`login-user:${name}`);
    let u = user;
    if (cfg.adminUsernames.includes(user.username) && user.role !== 'admin') u = repo.updateUser(user.id, { role: 'admin' });
    startSession(ctx, req, u);
    return { user: publicUser(u) };
  }, { auth: 'none' });

  router.post('/api/auth/logout', async (req) => {
    repo.deleteSession(req.sessionToken);
    clearSession(ctx, req);
    return { ok: true };
  }, { auth: 'optional' });

  router.post('/api/auth/forgot', async (req) => {
    const name = str(req.body.username, 254).toLowerCase();
    const allowed = limiter.hit(`forgot-ip:${req.ip}`, 10, 60 * MIN) && limiter.hit(`forgot-user:${name}`, 3, 60 * MIN);
    const user = allowed ? (repo.userByUsername(name) || (name.includes('@') ? repo.userByEmail(name) : null)) : null;
    if (user && !user.disabled) await sendResetLink(ctx, user);
    // Same answer whether or not the account exists.
    return { ok: true, message: 'If that account has an email address or a connected Discord, a reset link is on its way. Otherwise, ask an admin for a reset link.' };
  }, { auth: 'none' });

  router.post('/api/auth/reset', async (req) => {
    if (!limiter.hit(`reset-ip:${req.ip}`, 20, 60 * MIN)) throw new HttpError(429, 'Too many attempts — try again later');
    const password = checkPassword(req.body.password);
    const userId = repo.useReset(str(req.body.token, 200));
    if (!userId) throw bad('That reset link has expired or was already used — ask for a new one');
    const user = repo.updateUser(userId, { password_hash: await hashPassword(password) });
    // Sign out everywhere, including connected extensions.
    repo.deleteSessions(userId);
    repo.deleteDevices(userId);
    repo.addEvent(userId, { type: 'account', level: 'warn', message: 'Your password was reset. All browsers and extensions were signed out.' });
    startSession(ctx, req, user);
    return { ok: true };
  }, { auth: 'none' });

  // --- Account settings ------------------------------------------------------
  router.put('/api/me', async (req) => {
    const fields = { name: str(req.body.name, 80) };
    if (req.body.email !== undefined) fields.email = optionalEmail(req.body.email);
    const user = repo.updateUser(req.user.id, fields);
    return { user: publicUser(user) };
  });

  router.post('/api/me/password', async (req) => {
    if (!limiter.hit(`pw:${req.user.id}`, 10, 15 * MIN)) throw new HttpError(429, 'Too many attempts — try again later');
    if (!(await verifyPassword(req.body.current || '', req.user.password_hash))) throw bad('Your current password is wrong');
    const next = checkPassword(req.body.next);
    repo.updateUser(req.user.id, { password_hash: await hashPassword(next) });
    repo.deleteSessions(req.user.id, req.sessionHash);
    repo.addEvent(req.user.id, { type: 'account', level: 'info', message: 'Password changed. Other browsers were signed out.' });
    return { ok: true };
  });

  router.get('/api/me/export', async (req) => {
    const data = repo.exportUser(req.user.id);
    return {
      $raw: Buffer.from(JSON.stringify(data, null, 2)),
      type: 'application/json; charset=utf-8',
      headers: { 'content-disposition': `attachment; filename="${cfg.appName.toLowerCase()}-my-data.json"` },
    };
  });

  router.post('/api/me/delete', async (req) => {
    if (!(await verifyPassword(req.body.password || '', req.user.password_hash))) throw bad('Enter your password to delete your account');
    if (req.user.whop_membership_id && ['active', 'past_due'].includes(req.user.plan)) {
      await ctx.whop.cancelNow(req.user).catch(() => {
        throw new HttpError(502, "Couldn't cancel your Whop membership — try again, or cancel it on Whop first");
      });
    }
    // Leaving: take away the members' role in the Discord server.
    await ctx.discord.removeMember(req.user).catch(() => null);
    ctx.hub.disconnectUser(req.user.id);
    repo.deleteUser(req.user.id);
    clearSession(ctx, req);
    return { ok: true };
  });
}
