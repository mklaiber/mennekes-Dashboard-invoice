# Änderungsverlauf

## 1.1.0

- Optionale Home-Assistant-Sensoren über MQTT Discovery: legt bei gesetztem
  `mqtt_host` ein Gerät „Mennekes Wallbox" mit Sensoren für Ladeleistung,
  Status, Lädt/Fahrzeug-verbunden, Energie der Sitzung, Zählerstand, Strom,
  Spannung und aktive Ladekarte an. Zeigt bei anhaltenden Fehlversuchen oder
  beim Beenden „nicht verfügbar", statt veraltete Werte stehen zu lassen.
  Ohne `mqtt_host` bleibt das Add-on unverändert ein reiner Vermittler ohne
  Entitäten.
- Vorgabe-Konfiguration jetzt auf eine MENNEKES AMTRON (MHCP/1.0) eingestellt:
  `wallbox_auth_mode: query` mit `wallbox_auth_query_param: DevKey`,
  `endpoint_status: /ChargeData`, `endpoint_sessions: /ChargeRecords` und der
  neue `wallbox_sessions_protocol: amtron-stateful` für deren
  zustandsbehaftete Ladehistorie (Open/Read/Close). Andere
  Firmware-Generationen: Werte wie gewohnt in den Optionen anpassen.
- Neue Option `wallbox_auth_query_param` für Wallboxen, die den Token als
  Query-Parameter statt als Header verlangen (`wallbox_auth_mode: query`).

## 1.0.0

Erste Fassung.

- Liest Live-Zustand und Ladehistorie der Wallbox über deren REST-API
- Übermittelt beides ausgehend an die Online-Abrechnung; keine Portweiterleitung nötig
- Persistente Warteschlange unter `/data`: kein Ladevorgang geht bei einem
  Ausfall von Internet, Gegenstelle oder Strom verloren
- Bereits zugestellte Vorgänge werden nicht erneut gesendet
- Dauerhaft abgelehnte Datensätze werden verworfen, statt die Warteschlange zu blockieren
- Selbsttest beim Start prüft Wallbox und Gegenstelle
- Verweigert den Start, wenn das Ziel ohne TLS angegeben ist
