"""Envio por e-mail via SMTP. Configure por variáveis de ambiente (ver README / .env.example)."""
import os
import smtplib
import ssl
from email.message import EmailMessage


def smtp_config():
    return {
        "host": os.environ.get("SMTP_HOST", ""),
        "port": int(os.environ.get("SMTP_PORT", "587")),
        "user": os.environ.get("SMTP_USER", ""),
        "password": os.environ.get("SMTP_PASSWORD", ""),
        "sender": os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", "")),
        "ssl": os.environ.get("SMTP_SSL", "0") == "1",
    }


def is_configured():
    c = smtp_config()
    return bool(c["host"] and c["sender"])


def send(to, subject, body, attachments, reply_to=None):
    """attachments: lista de (nome_arquivo, bytes, mime 'type/subtype')."""
    cfg = smtp_config()
    if not is_configured():
        raise RuntimeError("Envio de e-mail não configurado no servidor (SMTP_HOST / SMTP_FROM).")
    msg = EmailMessage()
    msg["From"] = cfg["sender"]
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(body)
    for name, data, mime in attachments:
        maintype, subtype = mime.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)

    ctx = ssl.create_default_context()
    if cfg["ssl"]:
        with smtplib.SMTP_SSL(cfg["host"], cfg["port"], context=ctx, timeout=30) as s:
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=30) as s:
            s.starttls(context=ctx)
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
