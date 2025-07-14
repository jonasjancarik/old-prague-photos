# Old Prague Photos Geolocation 📸

This project scrapes, processes, and geolocates historical photos of Prague from the [Prague City Archives](http://katalog.ahmp.cz/pragapublica) public catalog. The final output is a structured CSV file containing photo metadata and geographical coordinates, suitable for mapping applications.

## ⚙️ Project Workflow

The data processing is handled by a series of scripts that form a sequential pipeline. Each step uses the output of the previous one.

1.  **`collect.py`**: Scrapes the archive website to get a list of all photo record IDs. It then scrapes the detailed metadata for each record and saves them as individual JSON files in `output/raw_records/`.

2.  **`filter.py`**: Reads the raw records and filters them into categories. It primarily separates records that contain a structured house number (`čp.`) from those that don't. The categorized lists are saved as JSON files in `output/filtered/`.

3.  **`geolocate.py`**: Processes the records that have a house number. It uses the [Mapy.cz API](https://api.mapy.cz/) to find the geographical coordinates for each address. Successfully geolocated records are saved in `output/geolocation/ok/`, while failures are moved to `output/geolocation/failed/`.

4.  **`export.py`**: Reads all successfully geolocated JSON files. It parses date information, flattens the data structure, and exports the final, clean dataset to `output/old_prague_photos.csv`.

---

## 🚀 Getting Started

Follow these steps to set up and run the project locally.

### 1. Prerequisites

-   Python 3.10 or newer
-   A Mapy.cz API key for the geolocation step. You can get one from the [Mapy.cz API developer page](https://api.mapy.cz/).

### 2. Setup

First, clone the repository to your local machine:
```bash
git clone <your-repository-url>
cd <your-repository-directory>
```

Next, create a Python virtual environment and activate it:
```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install the required dependencies:
```bash
pip install -r requirements.txt
```

Finally, create a `.env` file in the project's root directory to store your API key. Add the following line to the file, replacing `your_api_key_here` with your actual key:

```env
MAPY_CZ_API_KEY="your_api_key_here"
```

### 3. Running the Pipeline

Execute the scripts in the following order to perform the full data processing pipeline:

```bash
# 1. Scrape the raw data from the archive
python collect.py

# 2. Filter and categorize the scraped records
python filter.py

# 3. Geolocate records with house numbers using the Mapy.cz API
python geolocate.py

# 4. Export the final, geolocated data to a CSV file
python export.py
```
After running all the steps, the final dataset will be available at `output/old_prague_photos.csv`.

---

## 🛠️ Utility Scripts

The repository also includes a couple of utility scripts for specific tasks:

-   **`dezoomify.py`**: A standalone tool to download and stitch together high-resolution tiled images from the archive's Zoomify viewer. You need to provide the page URL directly in the script.
-   **`check.py`**: A script for validating and debugging the geolocation results by comparing the extracted neighborhood name with the results from the geolocation API.