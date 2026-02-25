import os, sys, json, argparse
import requests

API = "https://discord.com/api/v10"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--guild", default="")
    args = ap.parse_args()

    app_id = os.environ.get("DISCORD_APPLICATION_ID", "").strip()
    token  = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not app_id or not token:
        print("Il faut DISCORD_APPLICATION_ID et DISCORD_BOT_TOKEN en variables d'environnement.")
        sys.exit(1)

    commands = [
        {
            "name": "recherche",
            "description": "Recherche un perso/boss dans la base",
            "options": [
                {"type": 3, "name": "texte", "description": "Nom ou morceau du nom", "required": True},
                {"type": 3, "name": "jeu", "description": "ex: 7dso, genshin (optionnel)", "required": False},
            ],
        },
        {
            "name": "perso",
            "description": "Affiche la fiche complète d'un personnage (embeds)",
            "options": [
                {"type": 3, "name": "nom", "description": "Nom du perso (ou slug)", "required": True},
                {"type": 3, "name": "jeu", "description": "ex: 7dso, genshin (optionnel)", "required": False},
            ],
        },
        {
            "name": "boss",
            "description": "Affiche la fiche complète d'un boss (embeds)",
            "options": [
                {"type": 3, "name": "nom", "description": "Nom du boss (ou slug)", "required": True},
                {"type": 3, "name": "jeu", "description": "ex: 7dso, genshin (optionnel)", "required": False},
            ],
        },
    ]

    headers = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}

    if args.guild:
        url = f"{API}/applications/{app_id}/guilds/{args.guild}/commands"
        scope = "GUILD"
    else:
        url = f"{API}/applications/{app_id}/commands"
        scope = "GLOBAL"

    r = requests.put(url, headers=headers, data=json.dumps(commands))
    print(scope, r.status_code, r.text[:500])
    r.raise_for_status()

if __name__ == "__main__":
    main()
