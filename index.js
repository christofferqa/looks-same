'use strict';

const _ = require('lodash');
const parseColor = require('parse-color');
const colorDiff = require('color-diff');
const png = require('./lib/png');
const areColorsSame = require('./lib/same-colors');
const AntialiasingComparator = require('./lib/antialiasing-comparator');
const IgnoreCaretComparator = require('./lib/ignore-caret-comparator');
const utils = require('./lib/utils');
const readPair = utils.readPair;
const getDiffPixelsCoords = utils.getDiffPixelsCoords;

const JND = 2.3; //Just noticable difference
                //if ciede2000 >= JND then colors
                //difference is noticable by human eye

const getDiffArea = (diffPixelsCoords) => {
    const xs = [];
    const ys = [];

    diffPixelsCoords.forEach((coords) => {
        xs.push(coords[0]);
        ys.push(coords[1]);
    });

    const top = Math.min.apply(Math, ys);
    const bottom = Math.max.apply(Math, ys);

    const left = Math.min.apply(Math, xs);
    const right = Math.max.apply(Math, xs);

    const width = (right - left) + 1;
    const height = (bottom - top) + 1;

    return {left, top, width, height};
};

const createComparator = (png1, png2, opts) => {
    let comparator = opts.strict ? areColorsSame : makeCIEDE2000Comparator(opts.tolerance);

    if (opts.ignoreAntialiasing) {
        comparator = makeAntialiasingComparator(comparator, png1, png2);
    }

    if (opts.ignoreCaret) {
        comparator = makeNoCaretColorComparator(comparator, opts.pixelRatio);
    }

    return comparator;
};

const makeAntialiasingComparator = (comparator, png1, png2) => {
    const antialiasingComparator = new AntialiasingComparator(comparator, png1, png2);
    return (data) => antialiasingComparator.compare(data);
};

const makeNoCaretColorComparator = (comparator, pixelRatio) => {
    const caretComparator = new IgnoreCaretComparator(comparator, pixelRatio);
    return (data) => caretComparator.compare(data);
};

function makeCIEDE2000Comparator(tolerance) {
    return function doColorsLookSame(data) {
        if (areColorsSame(data)) {
            return true;
        }
        /*jshint camelcase:false*/
        const lab1 = colorDiff.rgb_to_lab(data.color1);
        const lab2 = colorDiff.rgb_to_lab(data.color2);

        return colorDiff.diff(lab1, lab2) < tolerance;
    };
}

const iterateRect = (width, height, callback, rowDoneCallback, endCallback) => {
    const processRow = (y) => {
        setImmediate(() => {
            for (let x = 0; x < width; x++) {
                callback(x, y);
            }

            var isLastRow = y >= height;
            rowDoneCallback(y, isLastRow);

            y++;

            if (!isLastRow) {
                processRow(y);
            } else {
                endCallback();
            }
        });
    };

    processRow(0);
};

const buildDiffImage = (png1, png2, options, callback) => {
    const width = Math.max(png1.width, png2.width);
    const height = Math.max(png1.height, png2.height);
    const minWidth = Math.min(png1.width, png2.width);
    const minHeight = Math.min(png1.height, png2.height);
    const highlightColor = options.highlightColor;
    const result = png.empty(width, height);

    var differences = 0;
    var pixelIgnored = false;

    var prevPrevRow = [];
    var prevRow = [];
    var currentRow = [];

    iterateRect(width, height, /*callback=*/(x, y) => {
        if (x >= minWidth || y >= minHeight) {
            result.setPixel(x, y, highlightColor);
            return;
        }

        const color1 = png1.getPixel(x, y);
        const color2 = png2.getPixel(x, y);

        if (!options.comparator({color1, color2})) {
            if (typeof options.ignoreDifferentPixels === 'function' &&
                options.ignoreDifferentPixels(x, y)) {
                pixelIgnored = true;
                result.setPixel(x, y, color1, /*alpha=*/100);
            } else {
                // Mark that the current row was different at position `x`.
                currentRow[x] = true;

                result.setPixel(x, y, highlightColor);
                ++differences;
            }
        } else {
            result.setPixel(x, y, color1, /*alpha=*/100);
        }
    },
    /*rowDoneCallback=*/(y, isLastRow) => {
        // Check each difference in `prevRow`.
        function checkRow(y) {
            for (var x = 0; x < prevRow.length; ++x) {
                if (prevRow[x] === true) {
                    var hasNeighboorDiff =
                        prevPrevRow[x-1] === true || prevPrevRow[x] === true ||
                            prevPrevRow[x+1] === true ||
                        prevRow[x-1] === true || prevRow[x+1] === true ||
                        currentRow[x-1] === true || currentRow[x] === true ||
                            currentRow[x+1] === true;
                    if (!hasNeighboorDiff) {
                        // Ignore this difference, since it is only a single pixel.
                        result.setPixel(x, y, png1.getPixel(x, y), /*alpha=*/100);
                        --differences;
                    }
                }
            }
        }

        checkRow(y-1);

        prevPrevRow = prevRow;
        prevRow = currentRow;
        currentRow = [];

        if (isLastRow) {
            checkRow(y);
        }
    },
    /*endCallback=*/() => callback(result, differences === 0, pixelIgnored));
};

const parseColorString = (str) => {
    const parsed = parseColor(str);

    return {
        R: parsed.rgb[0],
        G: parsed.rgb[1],
        B: parsed.rgb[2]
    };
};

const getToleranceFromOpts = (opts) => {
    if (!_.hasIn(opts, 'tolerance')) {
        return JND;
    }

    if (opts.strict) {
        throw new TypeError('Unable to use "strict" and "tolerance" options together');
    }

    return opts.tolerance;
};

const prepareOpts = (opts) => {
    opts.tolerance = getToleranceFromOpts(opts);

    if (opts.ignoreAntialiasing === undefined) {
        opts.ignoreAntialiasing = true;
    }
};

module.exports = exports = function looksSame(reference, image, opts, callback) {
    if (!callback) {
        callback = opts;
        opts = {};
    }

    prepareOpts(opts);

    readPair(reference, image, (error, pair) => {
        if (error) {
            return callback(error);
        }

        const first = pair.first;
        const second = pair.second;

        if (first.width !== second.width || first.height !== second.height) {
            return process.nextTick(() => callback(null, false));
        }

        const comparator = createComparator(first, second, opts);

        getDiffPixelsCoords(first, second, comparator, {stopOnFirstFail: true}, (result) => {
            callback(null, result.length === 0);
        });
    });
};

exports.getDiffArea = function(reference, image, opts, callback) {
    if (!callback) {
        callback = opts;
        opts = {};
    }

    prepareOpts(opts);

    readPair(reference, image, (error, pair) => {
        if (error) {
            return callback(error);
        }

        const first = pair.first;
        const second = pair.second;

        if (first.width !== second.width || first.height !== second.height) {
            return process.nextTick(() => callback(null, {
                width: Math.max(first.width, second.width),
                height: Math.max(first.height, second.height),
                top: 0,
                left: 0
            }));
        }

        const comparator = createComparator(first, second, opts);

        getDiffPixelsCoords(first, second, comparator, (result) => {
            if (!result.length) {
                return callback(null, null);
            }

            callback(null, getDiffArea(result));
        });
    });
};

exports.createDiff = function saveDiff(opts) {
    const tolerance = getToleranceFromOpts(opts);

    return new Promise((resolve, reject) => {
        readPair(opts.reference, opts.current, (error, pair) => {
            if (error) {
                reject(error);
                return;
            }

            var diffOptions = {
                highlightColor: parseColorString(opts.highlightColor),
                comparator: opts.strict ? areColorsSame : makeCIEDE2000Comparator(tolerance),
                ignoreDifferentPixels: null
            };

            function start() {
                buildDiffImage(pair.first, pair.second, diffOptions, (pair, equal, pixelIgnored) => {
                    if (equal) {
                        resolve({ equal: true, pixelIgnored: pixelIgnored });
                    } else {
                        pair.save(opts.diff, function callback(error) {
                            if (error) {
                                reject(error);
                            } else {
                                resolve({ equal: false });
                            }
                        });
                    }
                });
            }

            if (opts.ignoreDifferentPixels) {
                readPair(opts.ignoreDifferentPixels.reference, opts.ignoreDifferentPixels.current, (error, otherPair) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    var png1 = otherPair.first;
                    var png2 = otherPair.second;

                    diffOptions.ignoreDifferentPixels = function (x, y) {
                        const maxWidth = Math.max(png1.width, png2.width);
                        const maxHeight = Math.max(png1.height, png2.height);
                        const minWidth = Math.min(png1.width, png2.width);
                        const minHeight = Math.min(png1.height, png2.height);

                        if (x >= minWidth) {
                            return x < maxWidth;
                        } else if (y >= minHeight) {
                            return y < maxHeight;
                        }

                        const color1 = png1.getPixel(x, y);
                        const color2 = png2.getPixel(x, y);
                        return !diffOptions.comparator({color1, color2});
                    };

                    start();
                });
            } else {
                start();
            }
        });
    });
};

exports.colors = (color1, color2, opts) => {
    opts = opts || {};

    if (opts.tolerance === undefined) {
        opts.tolerance = JND;
    }

    const comparator = makeCIEDE2000Comparator(opts.tolerance);

    return comparator({color1, color2});
};
