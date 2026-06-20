#!/usr/bin/env python3
import sys
import argparse
import base64
import json
import time

try:
    import requests
except ImportError:
    print("Error: 'requests' module not found. Please install it using: pip install requests")
    sys.exit(1)

try:
    import argon2
except ImportError:
    print("Error: 'argon2-cffi' module not found. Please install it using: pip install argon2-cffi")
    sys.exit(1)

try:
    from zeroconf import Zeroconf, ServiceBrowser
except ImportError:
    print("Error: 'zeroconf' module not found. Please install it using: pip install zeroconf")
    sys.exit(1)


class LomorageListener:
    def __init__(self):
        self.services = []

    def update_service(self, zc, type_, name):
        pass

    def remove_service(self, zc, type_, name):
        pass

    def add_service(self, zc, type_, name):
        info = zc.get_service_info(type_, name)
        if info:
            addresses = [f"{addr}:{info.port}" for addr in info.parsed_addresses()]
            self.services.append({
                "name": info.name,
                "server": info.server,
                "addresses": addresses,
                "port": info.port
            })


def discover_services(timeout=5):
    print(f"Scanning for Lomorage services (_lomod._tcp.local.) for {timeout} seconds...")
    zeroconf = Zeroconf()
    listener = LomorageListener()
    browser = ServiceBrowser(zeroconf, "_lomod._tcp.local.", listener)
    
    time.sleep(timeout)
    zeroconf.close()
    
    return listener.services


def hash_password(username, password):
    # Salt is username + "@lomorage.lomoware"
    salt = (username + "@lomorage.lomoware").encode('utf-8')
    
    # Run Argon2id matching client parameters: memory=4096KB, time=3, parallelism=1, hash_len=32
    encoded = argon2.low_level.hash_secret(
        secret=password.encode('utf-8'),
        salt=salt,
        time_cost=3,
        memory_cost=4096,
        parallelism=1,
        hash_len=32,
        type=argon2.low_level.Type.ID
    )
    
    # Server expects hex-encoded version of the full standard encoded string with null-terminator
    encoded_str = encoded.decode('utf-8')
    hex_hash = encoded_str.encode('utf-8').hex() + "00"
    return hex_hash


def login(url, username, password, device_id="python-lomo-tool"):
    # Format url
    if not url.startswith("http"):
        url = f"http://{url}"
        
    print(f"Hashing password with Argon2id for user: {username}...")
    hashed_password = hash_password(username, password)
    
    # Build Basic auth credentials: base64(username:hashedPassword:deviceId)
    credentials = f"{username}:{hashed_password}:{device_id}"
    base64_creds = base64.b64encode(credentials.encode('utf-8')).decode('utf-8')
    
    print(f"Connecting to Lomorage server at {url}/login...")
    headers = {
        "Authorization": f"Basic {base64_creds}"
    }
    
    try:
        response = requests.get(f"{url}/login", headers=headers, timeout=10)
        if response.status_code == 200:
            data = response.json()
            token = data.get("Token")
            user_id = data.get("Userid")
            print("Login successful!")
            print(f"User ID: {user_id}")
            print(f"Token: {token}")
            return token
        else:
            print(f"Login failed with status code {response.status_code}: {response.text}")
    except Exception as e:
        print(f"Error during login: {e}")
    return None


def fetch_metadata(url, token, asset_hash):
    # Format url
    if not url.startswith("http"):
        url = f"http://{url}"
        
    print(f"Fetching metadata for asset hash {asset_hash}...")
    headers = {
        "Authorization": f"token={token}"
    }
    
    try:
        response = requests.get(f"{url}/asset/metadata/{asset_hash}", headers=headers, timeout=10)
        if response.status_code == 200:
            data = response.json()
            metadatas = data.get("Metadatas", [])
            print(f"\nMetadata for {asset_hash}:")
            print("=" * 60)
            for meta in metadatas:
                name = meta.get("Name")
                value = meta.get("Value")
                category = meta.get("Category")
                version = meta.get("Version")
                
                # Truncate long embedding values in console output
                display_value = value
                if name == "shared.similarity.clip.embedding" or name.endswith(".similarity.clip.embedding"):
                    if len(display_value) > 40:
                        display_value = display_value[:40] + f"... [Length: {len(value)} chars]"
                        
                print(f"Name:     {name}")
                print(f"Category: {category}")
                print(f"Version:  {version}")
                print(f"Value:    {display_value}")
                print("-" * 60)
        else:
            print(f"Failed to fetch metadata. Status code {response.status_code}: {response.text}")
    except Exception as e:
        print(f"Error fetching metadata: {e}")


def main():
    parser = argparse.ArgumentParser(description="Lomorage testing and discovery utility")
    subparsers = parser.add_subparsers(dest="command", help="Subcommands")

    # Discover subcommand
    subparsers.add_parser("discover", help="Discover Lomorage servers on the local network")

    # Login subcommand
    login_parser = subparsers.add_parser("login", help="Login to a server and print authorization token")
    login_parser.add_argument("--url", required=True, help="Server URL or IP:Port (e.g. 192.168.1.100:8000)")
    login_parser.add_argument("--user", required=True, help="Lomorage username")
    login_parser.add_argument("--password", required=True, help="Lomorage password")
    login_parser.add_argument("--device-id", default="python-lomo-tool", help="Custom device ID (default: python-lomo-tool)")

    # Metadata subcommand
    meta_parser = subparsers.add_parser("metadata", help="Fetch metadata for a given asset hash")
    meta_parser.add_argument("--url", required=True, help="Server URL or IP:Port")
    meta_parser.add_argument("--token", required=True, help="Auth token")
    meta_parser.add_argument("--hash", required=True, help="Asset MD5 hash string")

    args = parser.parse_args()

    if args.command == "discover":
        services = discover_services()
        if not services:
            print("No Lomorage services discovered.")
        else:
            print("\nDiscovered Lomorage Services:")
            print("=" * 60)
            for idx, svc in enumerate(services, 1):
                print(f"{idx}. {svc['name']}")
                print(f"   Server:    {svc['server']}")
                print(f"   Port:      {svc['port']}")
                print(f"   Addresses: {', '.join(svc['addresses'])}")
                print("-" * 60)

    elif args.command == "login":
        login(args.url, args.user, args.password, args.device_id)

    elif args.command == "metadata":
        fetch_metadata(args.url, args.token, args.hash)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
