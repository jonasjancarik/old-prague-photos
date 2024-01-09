# old-prague-photos

Project to geolocate old photos of Prague from the [Prague City Archives](http://katalog.ahmp.cz/pragapublica) website.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

1. `collect.py` - scrapes data from http://katalog.ahmp.cz/pragapublica
2. `process.py` - first processesing of the data, drops all the records that don't have at least one key named "rejstříkové záznamy"."místo"
3. `filter.py` - categorises the records according whether they have the house number and where in the record or not
4. `geolocate.py` - geolocates the records with house number
5. `export.py` - exports the data to CSV

## Status

- Currently only 10,000 records can be scraped out of 14,515 which seems to be a limitation of the website
- Around 5,000 records have house number - those can be geolocated using the Mapy.cz API, except for houses which do not exist anymore. When the house number exists in another part of Prague, the record is sometimes geolocated to the wrong place.
- For records without house number, a process needs to be added to extract the street name or landmark name from the record (potentially using an LLM) and geolocate it using the Mapy.cz API. This is not implemented yet.
- The data is exported to CSV and can be used to create a map. A work-in-progress version is available at https://public.tableau.com/app/profile/jonas.jancarik/viz/OldPraguePhotos/Mapa