# Lomorage Testing & Discovery Utilities

This directory contains standalone testing utilities (in both Python and Node.js) to:
1. Discover Lomorage servers on your local network using mDNS (Bonjour).
2. Authenticate using the same custom Argon2id password-hashing protocol used by Lomorage.
3. Query and inspect server metadata (like perceptual hashes and CLIP embeddings) for specific asset MD5 hashes.

---

## 1. Python Utility (`lomo_tool.py`)

### Setup & Dependencies
Ensure you have Python 3 installed. Install the required libraries:
```bash
pip3 install zeroconf requests argon2-cffi
```

### Usage Examples

* **mDNS Discovery**:
  ```bash
  ./lomo_tool.py discover
  ```

* **Authentication (Login)**:
  ```bash
  ./lomo_tool.py login --url 192.168.1.100:8000 --user username --password mypassword
  ```

* **Fetch Metadata**:
  ```bash
  ./lomo_tool.py metadata --url 192.168.1.100:8000 --token YOUR_TOKEN --hash IMAGE_MD5_HASH
  ```

---

## 2. Node.js Utility (`lomo_tool.js`)

### Setup & Dependencies
Install the required Node.js libraries. It is recommended to install them locally using `--no-save` to avoid committing them to the React Native `package.json`:
```bash
npm install argon2 bonjour-service --no-save
```

### Usage Examples

* **mDNS Discovery**:
  ```bash
  ./lomo_tool.js discover
  ```

* **Authentication (Login)**:
  ```bash
  ./lomo_tool.js login --url 192.168.1.100:8000 --user username --password mypassword
  ```

* **Fetch Metadata**:
  ```bash
  ./lomo_tool.js metadata --url 192.168.1.100:8000 --token YOUR_TOKEN --hash IMAGE_MD5_HASH
  ```
