# Änderungsverlauf

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
