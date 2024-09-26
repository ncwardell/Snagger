# Snagger 📺

| **IPTV Snagger and Manager** |  
Easily generate M3U and EPG data from sources like **PlutoTV** and manage them effortlessly.

---

## Overview
**Snagger** is a powerful tool designed to snag and manage IPTV streams. With Snagger, you can extract M3U playlists and Electronic Program Guide (EPG) data from various sources and transform them into standardized formats.

Use **Snagger** to:
- Generate M3U files and EPG XML from IPTV sources.
- Add and manipulate EPG channels and M3U segments with ease.
- Save your extracted data in desired formats for seamless integration with media players or services.

---

## Features

- **Dynamic Snagging**: Fetch IPTV data dynamically from different sources.
- **Flexible Data Handling**: Easily add M3U segments or EPG data, and combine them.
- **EPG and M3U Generation**: Automatically generate M3U playlists and XMLTV EPG data.
- **Source Management**: List and manage available IPTV sources with ease.
- **File Saving**: Save M3U and EPG data directly to your filesystem.

---

## Installation

1. Clone the repository:

    ```bash
    git clone https://github.com/your-username/Snagger.git
    ```

2. Navigate to the project directory:

    ```bash
    cd Snagger
    ```

3. Install dependencies:

    ```bash
    npm install
    ```

4. Build the project (if applicable):

    ```bash
    npm run build
    ```

---

## Usage

### Snagging Data from a Source

To snag data from a source (e.g., `PlutoTV`), you can use the following code:

```ts
const response = await Snagger.snag('PlutoTV');
await Snagger.save(response)

