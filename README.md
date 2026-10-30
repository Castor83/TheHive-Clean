# TheHive

Technischer Quellstand der lokalen Wartungs- und Handoff-Werkzeuge. Der persoenliche Wissens-Vault und alle gespeicherten Arbeitsstaende sind ausgeschlossen.

## Veroeffentlichter Umfang

Bereinigter Dateistand vom 29.10.2026, ohne vorherige Git-Historie. Enthaltene Originaldateien: 57.

Ergaenzung vom 30.10.2026: `work/handoff/.gitattributes` schuetzt die Byte-Hashes gespeicherter Arbeitsstaende vor automatischer Zeilenumwandlung durch Git. Der zugehoerige Test verlangt diese Datei ausdruecklich. Gespeicherte private Arbeitsstaende werden weiterhin nicht mitgeliefert.

Ebenfalls am 30.10.2026 wurde die lokal vorhandene Cline-Korrektur uebernommen: Fehler beim Schreiben des Diagnoseprotokolls ersetzen nicht mehr die Werkzeugpruefung. Ein Regressionstest prueft acht Eingabefaelle mit nicht beschreibbarem Protokollziel.

Persoenliche Notizen, Chats, Uebergaben, Zugangsdaten, lokale Laufzeitdaten, installierte Programme und Modelle werden nicht mitgeliefert. Lokale Benutzernamen wurden in den Releasekopien durch `USER` ersetzt. Die privaten Originalarbeitsbereiche werden separat weitergefuehrt.

Dies ist eine Quellstandsveroeffentlichung. Ein Build, Modelllauf oder allgemeiner Funktionstest dieses bereinigten Exports wurde nicht ausgefuehrt. Fehlende lokale Konfigurationen, externe Abhaengigkeiten und ausgeschlossene private Testdaten sind vor einem Einsatz selbst bereitzustellen.

## Aktualisierte Reparaturfassung vom 30.10.2026

Die vorhandenen lokalen Reparaturen und ihre Regressionstests sind in diese bereinigte Kopie uebernommen: Store-Sperren und Fehlererhalt, null-sichere App-Antworten, Wartungsergebnisse und Startpruefungen, Navigation bei temporaeren Dateien, fehlende historische Berichte, Signalpruefer-Argumente/Zitatschema und kollisionsfreie Graphgruppen. Vorhandene Aktualisierungen am Kontextwaechter und den zugehoerigen Uebergabehelfern sind ebenfalls enthalten.

Die benoetigten Snapshot-Helfer liegen unter work/maintenance/fixtures. Historischer Kandidat und aktueller Helfer sind getrennt und als Testvoraussetzungen dokumentiert; private Sitzungsdaten oder Hookkonfigurationen sind nicht enthalten. Der Obsidian-Routentest verwendet ein synthetisches Fixture.

Standalone Node- und Snapshot-Pythontests koennen ohne privates Benutzerprofil laufen. Die Quellen-/Navigationstests benoetigen weiterhin die vorhandene Open-Second-Brain-Bibliothek; der Graphpublikationstest benoetigt Graphify. Fehlende Bibliotheken sind keine bestandene Pruefung. Es werden weder Modelle gestartet noch Hooks installiert.

Die nach dem Abgleich ausgefuehrten Pruefungen werden im vorhandenen GitHub-PR beschrieben. Ein vollstaendiger natuerlicher Kontextwechsel ist weiterhin nicht abgenommen. Diese Fassung wird fuer das Review vorbereitet; kein Merge und keine Aktivierung im System des Reviewers.

### Pruefung dieser Clean-Fassung

Am 30.10.2026 in der bereinigten Windows-Arbeitskopie bestanden: 169 Node-Tests (11 betroffene Suiten), 64 Snapshot-/Waechtertests mit leerem synthetischem Benutzerprofil, 28 Quellen-/Navigationstests und 1 isolierter Graphpublikationstest. Keine Fehler oder uebersprungenen Tests in diesen ausgewaehlten Laeufen. Die Node- und Python-Pruefungen verwenden synthetische Sitzungen und simulierten Apptransport, keine echten Testchats.

Die Quellen-/Navigationstests nutzten die vorhandene Open-Second-Brain-Bibliothek, der Graph-Test die vorhandene Graphify-Installation. Diese Bibliotheken sind nicht Teil der 57 exportierten Originaldateien. Es wurden keine Abhaengigkeiten installiert. Die urspruengliche Windows-CI fuer PR2 war ein getrennter frueherer Nachweis; fuer diese aktualisierte Fassung wird kein neuer GitHub-CI-Lauf behauptet.

Zusaetzlich sind die vorher im Export fehlende handoff-naming.cjs-Abhaengigkeit und vollstaendige synthetische Policy-Dateimetadaten in den Tests enthalten. Ein Pfadvergleich bleibt nach Anonymisierung korrekt. Die private Automatik-Konfiguration bleibt ausgeschlossen.

### Wiederherstellung einer verwaisten Erwerbssperre

Bei nachgewiesen beendetem lokalem Besitzer kann der Store `.lock-gate` jetzt wiederherstellen. `handoff-gate-recovery.py` serialisiert die Wiederherstellung mit der vorhandenen Betriebssystemsperre aus `sync-text-graph.py`; es startet dabei keine Graphwartung und benoetigt kein Graphify. Die Sperre wird bei Prozessende automatisch freigegeben. Alte Gatebytes bleiben als `.lock-gate.stale-*` erhalten. Lebende, fremde oder unklare Besitzer bleiben unangetastet. Nur dieser Wiederherstellungspfad benoetigt ein bereits installiertes Python 3 unter dem Befehl `python`; bei fehlendem Python wird nichts entfernt und eine konkrete Fehlermeldung ausgegeben.
