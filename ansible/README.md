# Ansible-Deployment

Rollt die Anwendung als Docker-Container auf einen Debian/Ubuntu-Host aus.

## Einmalig vorbereiten

```bash
cd ansible

# Benötigte Collections installieren
ansible-galaxy collection install -r requirements.yml

# Inventar und Variablen anlegen
cp inventory.ini.example inventory.ini
cp group_vars/all.yml.example group_vars/all.yml

$EDITOR inventory.ini          # Zielhost eintragen
$EDITOR group_vars/all.yml     # Wallbox-IP, E-Mail, Preis ...
```

## Secrets in den Vault

Passwörter gehören nicht im Klartext ins Repo:

```bash
mkdir -p group_vars/all
ansible-vault create group_vars/all/vault.yml
```

Inhalt der Vault-Datei:

```yaml
auth_password: "<openssl rand -base64 24>"
smtp_password: "<SMTP-Passwort>"
mennekes_token: "<API-Token der Wallbox, falls benötigt>"
```

Danach die entsprechenden Klartext-Einträge aus `group_vars/all.yml` entfernen.

## Ausrollen

```bash
# Trockenlauf - zeigt, was sich ändern würde
ansible-playbook deploy.yml --check --diff --ask-vault-pass

# Vollständiges Deployment
ansible-playbook deploy.yml --ask-vault-pass

# Nur die .env neu schreiben und den Container durchstarten
ansible-playbook deploy.yml --tags config --ask-vault-pass
```

## Tags

| Tag      | Wirkung                                                   |
|----------|-----------------------------------------------------------|
| `docker` | Nur Docker Engine und Compose-Plugin installieren          |
| `setup`  | Nutzer, Gruppen und Verzeichnisse anlegen                  |
| `deploy` | Dateien übertragen, `.env` schreiben, Container bauen     |
| `config` | Nur `.env` neu erzeugen und Container neu starten          |
| `verify` | Nur den Health-Check gegen die laufende Instanz ausführen |

## Was das Playbook macht

1. Prüft die Pflichtvariablen (`auth_password` mind. 12 Zeichen, `mennekes_base_url`, `mail_to`) und bricht sonst ab.
2. Installiert Docker Engine samt Compose-Plugin aus dem offiziellen Docker-Repository.
3. Legt Systemnutzer `wallbox` an (ohne Login-Shell, Mitglied der `docker`-Gruppe).
4. Synchronisiert das Projekt nach `/opt/mennekes-billing` — ohne `.git`, `node_modules`, `data` und die lokale `.env`.
5. Erzeugt `/opt/mennekes-billing/.env` aus `templates/env.j2` mit Rechten `0640` (`no_log: true`, die Secrets erscheinen nicht in der Ansible-Ausgabe).
6. Baut das Image und startet den Container per `docker compose`.
7. Wartet, bis `/api/health` antwortet, und meldet, ob auch die Wallbox erreichbar ist.

## Betrieb auf dem Zielhost

```bash
cd /opt/mennekes-billing

docker compose logs -f                                  # Logs
docker compose restart                                  # Neustart
docker compose exec wallbox-billing \
  node scripts/run-report.js --month 3 --year 2026 --no-mail   # Nachlauf ohne Versand
```
