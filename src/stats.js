module.exports.Stats = class Stats {
    constructor() {
        this.itemsTotal = 0;
        this.itemsSkipped = 0;
        this.imagesTotal = 0;
        this.imagesAlreadyOnS3 = 0;
        this.imagesUploaded = 0;
        this.imagesFailed = 0;
        this.imagesDuplicates = 0;
        this.imagesDownloadedPreviously = 0;
        this.itemsWithoutImages = 0;
        this.failedInfo = [];
    }

    inc(prop) {
        if (this[prop] == null) {
            throw new Error(`Property ${prop} is not initiated in the Stats class so it cannot be incremented!`);
        }
        this[prop]++;
    }

    set(prop, val) {
        if (this[prop] == null) {
            throw new Error(`Property ${prop} is not initiated in the Stats class so it cannot be incremented!`);
        }
        this[prop] = val;
    }

    addFailed(failedObject) {
        if (typeof faileObject !== 'object' || !failedObject.url || !failedObject.errors) { // add other later
            console.log('failed object');
            console.dir(failedObject, { depth: null });
            throw new Error('Argument to "addFailed" of Stat class must be object with url and errors properties!');
        }
        this.failedInfo.push(failedObject);
    }

    return() {
        const statsKeys = Object.keys(this);
        const statsObject = {};
        for (const key of statsKeys) {
            statsObject[key] = this[key];
        }
        return statsObject;
    }

    display() {
        const statsObject = this.return();
        console.log('*** STATS ***');
        console.dir(statsObject);
    }

    getProps() {
        return {
            itemsTotal: 'itemsTotal',
            itemsSkipped: 'itemsSkipped',
            imagesTotal: 'imagesTotal',
            imagesAlreadyOnS3: 'imagesAlreadyOnS3',
            imagesUploaded: 'imagesUploaded',
            imagesFailed: 'imagesFailed',
            imagesDuplicates: 'imagesDuplicates',
            imagesDownloadedPreviously: 'imagesDownloadedPreviously',
            itemsWithoutImages: 'itemsWithoutImages',
            failedInfo: 'failedInfo',
        };
    }
};
