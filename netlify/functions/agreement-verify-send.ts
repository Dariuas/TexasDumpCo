import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { sendEmail } from "./_shared/email";
import { makeChallenge } from "./_shared/agreement-verify";

// Public: emails a 6-digit code to prove the signer controls the email address.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { email, lang } = await readJson<{ email?: string; lang?: string }>(req);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return badRequest("Valid email required");
  const { code, token } = makeChallenge(email);
  const es = lang === "es";
  await sendEmail(
    email,
    es ? "Su código de verificación — Texas Dumpster Co" : "Your verification code — Texas Dumpster Co",
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
       <p>${es ? "Use este código para firmar su contrato de renta:" : "Use this code to sign your rental agreement:"}</p>
       <p style="font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p>
       <p style="color:#666">${es ? "Vence en 15 minutos. Si no lo solicitó, ignore este mensaje." : "Expires in 15 minutes. If you didn't request this, ignore this email."}</p>
     </div>`,
  );
  return json({ token });
});
