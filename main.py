import load_matches
import schedule
import time


def main():
    schedule.every().day.at("22:00").do(load_matches.main)
    schedule.every().day.at("05:00").do(load_matches.main)
    schedule.every().wednesday.at("21:00").do(load_matches.main)
    schedule.every().wednesday.at("23:00").do(load_matches.main)


if __name__ == "__main__":
    while True:
        schedule.run_pending()
        time.sleep(60)
