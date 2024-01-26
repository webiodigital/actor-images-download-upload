import { Actor, log } from 'apify';
import { BasicCrawler, BasicCrawlingContext, KeyValueStore, RequestList } from 'crawlee';
import objectPath from 'object-path';
import md5 from 'md5';

// import path from 'path';
// import fs from 'fs';
// import heapdump from 'heapdump';

import { downloadUpload } from './download-upload.js';
import { checkIfAlreadyOnS3 } from './utils.js';
import { archiveKVS, deleteArchiveFile } from './archive-files.js';

export default async ({ data, iterationInput, iterationIndex, stats, originalInput }: any) => {
    const props = stats.getProps();

    // Periodically displaying stats
    const statsInterval = setInterval(async () => {
        stats.display();
        await Actor.setValue('stats-state', stats.return());
    }, 10 * 1000);

    const {
        uploadTo,
        pathToImageUrls,
        outputTo,
        outputDatasetId,
        fileNameFunction,
        preDownloadFunction,
        postDownloadFunction,
        maxConcurrency,
        s3CheckIfAlreadyThere,
        imageCheck,
        downloadUploadOptions,
        stateFields,
        noDownloadRun,
    } = iterationInput;
    
    log.info('loading state...');

    const state: any = (await Actor.getValue(`STATE-IMAGES-${iterationIndex}`)) || {};

    const iterationState: any = await Actor.getValue('STATE-ITERATION');
    if (!iterationState[iterationIndex]) {
        iterationState[iterationIndex] = {
            index: iterationIndex,
            pushed: 0,
            started: false,
            finished: false,
        };
    }
    
    if (outputTo === 'dataset' && uploadTo === 'zip-file') {
        log.warning('You cannot use dataset and zip-file at the same time, using zip-file only');
    }

    log.info('Images loaded from state:');
    log.info(`Uploaded: ${Object.values(state).filter((val: any) => val.imageUploaded).length}`);
    log.info(`Failed: ${Object.values(state).filter((val: any) => val.imageUploaded === false).length}`);
    log.info(`Not yet handled: ${Object.values(state).filter((val: any) => val.imageUploaded === undefined).length}`);

    // SAVING STATE
    const stateInterval = setInterval(async () => {
        await Actor.setValue(`STATE-IMAGES-${iterationIndex}`, state);
    }, 10 * 1000);

    Object.keys(state).forEach((key: any) => {
        state[key].fromState = true;
    });

    const updateStats = !iterationState[iterationIndex].started;
    if (data.length === 0) {
        throw new Error('We loaded no data from the specified input, aborting the run!');
    }

    if (data.length === 0) throw new Error("Didn't load any items from kv store or dataset");

    log.info(`We got ${data.length} items in iteration index: ${iterationIndex}`);
    log.info('STARTING DOWNLOAD');

    // Filtering items
    if (preDownloadFunction) {
        try {
            log.info('Transforming items with pre download function');
            log.info(preDownloadFunction);
            data = await preDownloadFunction({ data, iterationIndex, input: originalInput });
            log.info(`We got ${data.length} after pre download`);
        } catch (e) {
            console.dir(e);
            throw new Error('Pre download function failed with error');
        }
    }

    const itemsSkippedCount = data.filter((item: any) => !!item.skipDownload).length;
    stats.add(props.itemsSkipped, itemsSkippedCount, updateStats);

    // Add images to state
    try {
        let imageIndex = 13;
        data.forEach((item: any, itemIndex: number) => {
            if (item.skipDownload) return; // we skip item with this field
            let imagesFromPath = objectPath.get(item, pathToImageUrls);
            if (!Array.isArray(imagesFromPath) && typeof imagesFromPath !== 'string') {
                stats.inc(props.itemsWithoutImages, updateStats);
                return;
            }
            if (typeof imagesFromPath === 'string') {
                imagesFromPath = [imagesFromPath];
            }
            if (imagesFromPath.length === 0) {
                stats.inc(props.itemsWithoutImages, updateStats);
                return;
            }
            imagesFromPath.forEach((image: any) => {
                stats.inc(props.imagesTotal, updateStats);
                if (typeof image !== 'string') {
                    stats.inc(props.imagesNotString, updateStats);
                    return;
                }
                // undefined means they were not yet added
                // false means they were not yet downloaded / uploaded or the process failed
                if (state[image] === undefined) {
                    state[image] = {
                        imageIndex,
                        itemIndex,
                    };
                    imageIndex++;
                } else if (typeof state[image] === 'object' && state[image].fromState) {
                    // stats.inc(props.imagesDownloadedPreviously, updateStats);
                } else {
                    if (!state[image].duplicateIndexes) {
                        state[image].duplicateIndexes = [];
                    }
                    if (!state[image].duplicateIndexes.includes(itemIndex)) {
                        state[image].duplicateIndexes.push(itemIndex);
                    }
                    stats.inc(props.imagesDuplicates, updateStats);
                }
            });
            // **************
            imagesFromPath.forEach((element) => {
                console.log(element);
            });
            // **************
        });
    } catch (e) {
        console.dir(e);
        throw new Error(`Adding images to state failed with error: ${(e as Error).message}`);
    }

    const requestList = await RequestList.open('main', Object.keys(state).map((url) => ({ url })));

    iterationState[iterationIndex].started = true;
    await Actor.setValue('STATE-ITERATION', iterationState);

    const filterStateFields = (stateObject: any, fields: any) => {
        if (!fields) {
            return stateObject;
        }
        const newObject: any = {
            imageUploaded: stateObject.imageUploaded,
        };
        fields.forEach((field: any) => {
            newObject[field] = stateObject[field];
        });
        return newObject;
    };

    const requestHandler = async ({ request }: BasicCrawlingContext) => {
        const { url } = request;

        log.info(`Downloading image ${url.slice(0, 55)}...`);

        if (typeof state[url].imageUploaded === 'boolean') return; // means it was already download before
        const item = data[state[url].itemIndex];
        const key = fileNameFunction({ url, md5, state, item, iterationIndex, input: originalInput });
        // If filename is not a string, we don't continue. This can be used to prevent the download at this point
        if (typeof key !== 'string') {
            state[url].imageUploaded = false;
            state[url].errors = [{ when: 'before-download', error: 'fileNameFunction didn\'t provide a string' }];
            state[url] = filterStateFields(state[url], stateFields);
            stats.inc(props.imagesNoFilename, true);
            return;
        }
        if (s3CheckIfAlreadyThere && uploadTo === 's3') {
            const { isThere, errors } = await checkIfAlreadyOnS3(key, downloadUploadOptions.uploadOptions);
            if (isThere) {
                state[url].imageUploaded = true; // not really uploaded but we need to add this status
                state[url].errors = errors;
                state[url] = filterStateFields(state[url], stateFields);
                stats.inc(props.imagesAlreadyOnS3, true);
                return;
            }
        }
        // We provide an option for a dummy run to check duplicates etc.
        const info = noDownloadRun
            ? { imageUploaded: true, time: { downloading: 0, processing: 0, uploading: 0 } }
            : await downloadUpload(url, key, downloadUploadOptions, imageCheck);
        stats.add(props.timeSpentDownloading, info.time.downloading, true);
        stats.add(props.timeSpentProcessing, info.time.processing, true);
        stats.add(props.timeSpentUploading, info.time.uploading, true);

        state[url] = { ...state[url], ...info };
        state[url] = filterStateFields(state[url], stateFields);
        if (info.imageUploaded) {
            stats.inc(props.imagesUploaded, true);
        } else {
            stats.inc(props.imagesFailed, true);
            stats.addFailed({ url, errors: info.errors });
        }

    };

    const crawler = new BasicCrawler({
        requestList,
        requestHandler,
        autoscaledPoolOptions: {
            desiredConcurrencyRatio: 0.4,
            scaleUpStepRatio: 0.5,
            snapshotterOptions: {
                maxBlockedMillis: 100,
            },
            systemStatusOptions: {
                maxEventLoopOverloadedRatio: 0.9,
            },
        },
        maxConcurrency,
        failedRequestHandler: async ({ request }: BasicCrawlingContext, error: Error) => {
            const { url } = request;
            stats.inc(props.imagesFailed, true);
            stats.addFailed({ url, errors: [`Handle function failed! ${error.toString()}`] });
        },
        requestHandlerTimeoutSecs: 180,
    });

    await crawler.run();

    log.info(`All images in iteration ${iterationIndex} were processed`);

    // TODO: Until fixed, move this to separate fork
    /*
    if (downloadUploadOptions.isDebug) {
        const dumpName = `${Date.now()}-${iterationIndex}.heapsnapshot`;
        const dumpPath = path.join(__dirname, dumpName);

        heapdump.writeSnapshot(dumpPath, (err, filename) => {
            log.info('snapshot written:', err, filename);
        });

        const dumpBuff = fs.readFileSync(dumpPath);
        await Actor.setValue(dumpName, dumpBuff, { contentType: 'application/octet-stream' });
    }
    */

    if (uploadTo === 'zip-file') {
        log.info('Archiving Images...');

        const storeHandle: KeyValueStore = downloadUploadOptions.uploadOptions.storeHandle;

        const archive = await archiveKVS(storeHandle);

        const zipFileStore = await Actor.openKeyValueStore();

        await zipFileStore.setValue('images-archive', archive, { contentType: 'application/zip' });

        const zipFileUrl = zipFileStore.getPublicUrl('images-archive');

        await Actor.pushData({ zipFileUrl });

        // Drop the store after we are done with it
        await storeHandle.drop();
        
        deleteArchiveFile();
    }

    // postprocessing function
    if ((outputTo && outputTo !== 'no-output')) {
        log.info(`Will save output data to: ${outputTo}`);
        let processedData = postDownloadFunction
            ? await postDownloadFunction({ data, state, fileNameFunction, md5, iterationIndex, input: originalInput }, { Actor, objectPath })
            : data;
        log.info('Post-download processed data length:', processedData.length);

        if (outputTo === 'key-value-store') {
            const alreadySavedData: any[] = (await Actor.getValue('OUTPUT')) || [];
            await Actor.setValue('OUTPUT', alreadySavedData.concat(processedData));
        }

        // Have to save state of dataset push because it takes too long
        if (outputTo === 'dataset') {
            const chunkSize = 500;
            let index = iterationState[iterationIndex].pushed;
            log.info(`Loaded starting index: ${index}`);
            for (; index < processedData.length; index += chunkSize) {
                log.info(`pushing data ${index}:${index + chunkSize}`);
                iterationState[iterationIndex].pushed = index + chunkSize;
                const dataset = await Actor.openDataset(outputDatasetId);
                await Promise.all([
                    dataset.pushData(processedData.slice(index, index + chunkSize)),
                    Actor.setValue('STATE-ITERATION', iterationState),
                ]);
            }
        }
        processedData = null;
    }
    clearInterval(statsInterval);
    // Saving STATE for last time
    clearInterval(stateInterval);
    iterationState[iterationIndex].finished = true;
    iterationState[iterationIndex + 1] = {
        index: iterationIndex + 1,
        started: false,
        finished: false,
        pushed: 0,
    };
    await Actor.setValue('STATE-ITERATION', iterationState);
    await Actor.setValue(`STATE-IMAGES-${iterationIndex}`, state);
    log.info('END OF ITERATION STATS:');
    stats.display();
};
