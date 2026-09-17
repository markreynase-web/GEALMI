// src/mailer.js
// Envío de correo vía la API REST de Brevo (HTTPS), no SMTP.
//
// Antes esto era SMTP genérico con nodemailer ("funciona con cualquier
// proveedor"). Se cambió porque en producción (Render, plan free) las
// conexiones salientes por SMTP a smtp-relay.brevo.com:587 nunca conectan
// -- confirmado en los logs: "Connection timeout", con host/usuario/clave
// correctos. HTTPS no tiene ese problema (es el mismo tipo de llamada que ya
// hace gealmiAiTools.js contra la API de Anthropic, que sí funciona). El
// trade-off es real: esto ata el envío de correo específicamente a Brevo, ya
// no es "cualquier SMTP" -- aceptado a propósito para que la recuperación de
// contraseña funcione en el hosting real, no solo en teoría.
//
// Nada se hardcodea -- BREVO_API_KEY y EMAIL_FROM salen de variables de
// entorno (ver .env.example). Si BREVO_API_KEY no está configurada,
// enviarCorreoRecuperacion() no revienta: registra el enlace en el log del
// servidor, para poder probar el flujo completo sin credenciales reales
// mientras desarrollas (mismo criterio que antes con SMTP no configurado).

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

// EMAIL_FROM ya viene como "GEALMI <correo@dominio.com>" (ver
// .env.example) -- se reutiliza el mismo valor en vez de pedir variables
// nuevas, porque ya está bien cargado tanto en local como en Render.
function remitenteConfigurado() {
  const from = process.env.EMAIL_FROM || '';
  const m = from.match(/^(.*)<(.+)>$/);
  if (m) return { name: m[1].trim() || 'GEALMI', email: m[2].trim() };
  return from ? { name: 'GEALMI', email: from.trim() } : null;
}

function plantillaRecuperacion({ nombre, resetUrl }) {
  // HTML de correo: estilos inline (no <style> en <head>) porque muchos
  // clientes de correo ignoran o recortan hojas de estilo -- es la forma
  // confiable de que se vea igual en Gmail/Outlook/Apple Mail. Mismos
  // colores de marca que login.html (--ink/--brand-2/--teal/--cyan).
  return `
<!DOCTYPE html>
<html lang="es">
<body style="margin:0; padding:0; background:#F3F8FC; font-family:'Segoe UI', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F8FC; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px; background:#FFFFFF; border-radius:16px; overflow:hidden;">
        <tr>
          <td style="background:#0E1B45; padding:28px 32px;">
            <span style="font-size:20px; font-weight:700; color:#F3F8FC;"><span style="color:#2EE2CE;">G</span>EALMI</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 16px; font-size:15px; line-height:1.55; color:#16295C;">Hola${nombre ? ` ${nombre}` : ''},</p>
            <p style="margin:0 0 24px; font-size:15px; line-height:1.55; color:#16295C;">
              Recibimos una solicitud para restablecer la contraseña de tu cuenta de GEALMI.
              Haz clic en el siguiente botón para crear una nueva contraseña:
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
              <tr><td style="border-radius:999px; background:#16295C;">
                <a href="${resetUrl}" style="display:inline-block; padding:14px 28px; font-size:14.5px; font-weight:600; color:#FFFFFF; text-decoration:none; border-radius:999px;">Restablecer contraseña</a>
              </td></tr>
            </table>
            <p style="margin:0 0 8px; font-size:13px; line-height:1.5; color:#4E5A78;">Este enlace expirará en 30 minutos.</p>
            <p style="margin:0; font-size:13px; line-height:1.5; color:#4E5A78;">Si no solicitaste este cambio, puedes ignorar este correo -- tu contraseña actual sigue funcionando igual.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px; border-top:1px solid #E1E7F0;">
            <p style="margin:0; font-size:12px; color:#9AA6C0;">GEALMI -- El conocimiento ancestral convertido en inteligencia empresarial.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * @returns {Promise<{enviado:boolean, motivo?:string}>} -- nunca lanza: el
 * llamador (routes/auth.js) siempre responde el mismo mensaje genérico al
 * usuario, se haya podido enviar el correo o no.
 */
export async function enviarCorreoRecuperacion({ to, nombre, resetUrl }) {
  const apiKey = process.env.BREVO_API_KEY;
  const sender = remitenteConfigurado();

  if (!apiKey || !sender) {
    console.warn(`[mailer] BREVO_API_KEY o EMAIL_FROM no configurados -- enlace de recuperación para ${to}:\n  ${resetUrl}`);
    return { enviado: false, motivo: 'no_configurado' };
  }

  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender,
        to: [{ email: to, name: nombre || undefined }],
        subject: 'Restablece tu contraseña de GEALMI',
        htmlContent: plantillaRecuperacion({ nombre, resetUrl })
      })
    });
    if (!res.ok) {
      const cuerpo = await res.json().catch(() => ({}));
      console.error('No se pudo enviar el correo de recuperación (Brevo):', res.status, cuerpo.message || JSON.stringify(cuerpo));
      return { enviado: false, motivo: 'error_envio' };
    }
    return { enviado: true };
  } catch (err) {
    console.error('No se pudo enviar el correo de recuperación:', err.message);
    return { enviado: false, motivo: 'error_envio' };
  }
}
