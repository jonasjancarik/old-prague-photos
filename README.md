# old-prague-photos

Project to geolocate old photos of Prague from the [Prague City Archives](http://katalog.ahmp.cz/pragapublica) website.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

To get started without scraping data, download the raw records directory from https://www.dropbox.com/scl/fi/xxrqjzcc8bbc4nc2sbsil/raw_records.zip?rlkey=bf6yechb3fruh1sab0rorl9rb&dl=0 and place it in `./output` (i.e. you should then have `./output/raw_records` with individual JSON files in it). With this, you can skip the first step and go straight to the second step.

1. `collect.py` - scrapes data from http://katalog.ahmp.cz/pragapublica
2. `filter.py` - categorises the records according whether they have the house number (and where in the record) or not
3. `geolocate.py` - geolocates the records with house number
4. `export.py` - exports the data to CSV

## Status

The numbers here are indicative only and will change as the geolocation process is improved.

- Currently only 10,000 records can be scraped out of 14,515 which seems to be a limitation of the website
- Around 5,800 records have a house number - those can be geolocated using the Mapy.cz API, except for houses which do not exist anymore. When the house number exists in another part of Prague, the record is sometimes geolocated to the wrong place.
- 4,569 records can currently be geolocated using the Mapy.cz API (error rate unknown)
- For records without house number, a process needs to be added to extract the street name or landmark name from the record (potentially using an LLM) and geolocate it using the Mapy.cz API. This is not implemented yet.
- The data is exported to CSV and can be used to create a map. A work-in-progress version is available at https://public.tableau.com/app/profile/jonas.jancarik/viz/OldPraguePhotos/Mapa