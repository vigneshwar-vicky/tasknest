import emailjs from "@emailjs/browser";

const SERVICE_ID  = "service_1pi4kca";
const TEMPLATE_ID = "template_3e282mb";
const PUBLIC_KEY  = "8GpnlxYEEPYtypCL0";

export function sendTaskExpiredEmail(toEmail, toName, taskName) {
  return emailjs
    .send(
      SERVICE_ID,
      TEMPLATE_ID,
      {
        to_name:   toName,
        to_email:  toEmail,
        task_name: taskName,
        message:   `Your task "${taskName}" has expired.`,
      },
      PUBLIC_KEY
    )
    .catch((err) => {
      console.error("EmailJS error:", err);
    });
}