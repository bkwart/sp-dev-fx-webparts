import ISearchDataProvider from "./ISearchDataProvider";
import { ISearchResults, ISearchResult, IRefinementResult, IRefinementValue, IRefinementFilter } from "../models/ISearchResult";
import pnp, { ConsoleListener, Logger, LogLevel, SearchQuery, SearchQueryBuilder, SearchResults, setup, Web, Sort, SortDirection } from "sp-pnp-js";
import { IWebPartContext } from "@microsoft/sp-webpart-base";
import { Text, JsonUtilities, UrlUtilities  } from "@microsoft/sp-core-library";
import sortBy from "lodash-es/sortBy";
import groupBy from 'lodash-es/groupBy';
import mapValues from 'lodash-es/mapValues';
import mapKeys from "lodash-es/mapKeys";
import * as moment from "moment";

class SearchDataProvider implements ISearchDataProvider {

    private _resultsCount: number;
    private _context: IWebPartContext;
    private _appSearchSettings: SearchQuery;
    private _selectedProperties: string[];

    public get resultsCount(): number { return this._resultsCount; }
    public set resultsCount(value: number) { this._resultsCount = value; }

    public set selectedProperties(value:  string[]) { this._selectedProperties = value; }
    public get selectedProperties(): string[] { return this._selectedProperties; }

    public constructor(webPartContext: IWebPartContext) {
        this._context = webPartContext;
        
        // Setup the PnP JS instance
        const consoleListener = new ConsoleListener();
        Logger.subscribe(consoleListener);

        // To limit the payload size, we set odata=nometadata
        // We just need to get list items here
        // We also set the SPFx context accordingly (https://github.com/SharePoint/PnP-JS-Core/wiki/Using-sp-pnp-js-in-SharePoint-Framework)
        setup({
            sp: {
                headers: {
                    Accept: "application/json; odata=nometadata",
                },
            },
            spfxContext: this._context,
        });
    }

    /**
     * Performs a search query against SharePoint
     * @param query The search query in KQL format
     * @return The search results
     */
    public async search(query: string, refiners?: string, refinementFilters?: IRefinementFilter[], pageNumber?: number): Promise<ISearchResults> {
        
        let searchQuery: SearchQuery = {};
        let sortedRefiners: string[] = [];

        // Search paging option is one based
        let page = pageNumber ? pageNumber: 1;

        searchQuery.ClientType = "ContentSearchRegular";

        // To be able to use search query variable according to the current context
        // http://www.techmikael.com/2015/07/sharepoint-rest-do-support-query.html
        searchQuery.QueryTemplate = query ? query : "";;

        searchQuery.RowLimit = this._resultsCount;
        searchQuery.SelectProperties = this._selectedProperties;
        searchQuery.TrimDuplicates = false;

        let sortList: Sort[] = [
            {
                Property: "Created",
                Direction: SortDirection.Descending
            },
            {
                Property: "Size",
                Direction: SortDirection.Ascending
            }
        ];

        searchQuery.SortList = sortList;

        if (refiners) {
            // Get the refiners order specified in the property pane
            sortedRefiners = refiners.split(",");
            searchQuery.Refiners = refiners ? refiners : "";
        }
        
        if (refinementFilters) {
            if (refinementFilters.length > 0) {
                searchQuery.RefinementFilters = [this._buildRefinementQueryString(refinementFilters)];
            }
        }

        let results: ISearchResults = {
            RelevantResults : [],
            RefinementResults: [],
            TotalRows: 0,
        };

        try {
    
            const r = await pnp.sp.search(searchQuery);

            const allItemsPromises: Promise<any>[] = [];
            let refinementResults: IRefinementResult[] = [];

            // Need to do this check
            // More info here: https://github.com/SharePoint/PnP-JS-Core/issues/337
            if (r.RawSearchResults.PrimaryQueryResult) {
                        
                // Be careful, there was an issue with paging calculation under 2.0.8 version of sp-pnp-js library
                // More info https://github.com/SharePoint/PnP-JS-Core/issues/535
                const r2 = await r.getPage(page, this._resultsCount);

                const resultRows = r2.RawSearchResults.PrimaryQueryResult.RelevantResults.Table.Rows;
                let refinementResultsRows = r2.RawSearchResults.PrimaryQueryResult.RefinementResults;

                const refinementRows = refinementResultsRows ? refinementResultsRows["Refiners"] : [];

                // Map search results
                resultRows.map((elt) => {

                    const p1 = new Promise<ISearchResult>((resolvep1, rejectp1) => {
                    
                        // Build item result dynamically
                        // We can't type the response here because search results are by definition too heterogeneous so we treat them as key-value object
                        let result: ISearchResult = {};

                        elt.Cells.map((item) => {
                            result[item.Key] = item.Value;
                        });

                        // Get the icon source URL
                        this._mapToIcon(result.Filename).then((iconUrl) => {

                            result.iconSrc = iconUrl;                            
                            resolvep1(result);

                        }).catch((error) => {
                            rejectp1(error);
                        });                       
                    });

                    allItemsPromises.push(p1);                
                });

                // Map refinement results                    
                refinementRows.map((refiner) => {
                    
                    let values: IRefinementValue[] = [];
                    refiner.Entries.map((item) => {
                        values.push({
                            RefinementCount: item.RefinementCount,
                            RefinementName:  this._formatDate(item.RefinementName), //This value will appear in the selected filter bar
                            RefinementToken: item.RefinementToken,
                            RefinementValue: this._formatDate(item.RefinementValue), // This value will appear in the filter panel
                        });
                    });

                    refinementResults.push({
                        FilterName: refiner.Name,
                        Values: values,
                    });
                });

                // Resolve all the promises once to get news
                const relevantResults: ISearchResult[] = await Promise.all(allItemsPromises);
                    
                // Sort refiners according to the property pane value
                refinementResults = sortBy(refinementResults, (refinement) => {

                    // Get the index of the corresponding filter name
                    return sortedRefiners.indexOf(refinement.FilterName);
                });

                results.RelevantResults = relevantResults;
                results.RefinementResults = refinementResults,
                results.TotalRows = r.TotalRows;
            }
            return results;

        } catch (error) {
            Logger.write("[SharePointDataProvider.search()]: Error: " + error, LogLevel.Error);
            throw error;
        }       
    }

    /**
     * Gets the icon corresponding to the file name extension
     * @param filename The file name (ex: file.pdf)
     */
    private async _mapToIcon(filename: string): Promise<string> {
        
        const webAbsoluteUrl = this._context.pageContext.web.absoluteUrl;
        const web = new Web(webAbsoluteUrl);
        
        try {
            const encodedFileName = filename ? filename.replace(/["']/g, "") : "";
            const iconFileName = await web.mapToIcon(encodedFileName,1);
            const iconUrl = webAbsoluteUrl + "/_layouts/15/images/" + iconFileName;

            return iconUrl;

        } catch (error) {
            Logger.write("[SharePointDataProvider._mapToIcon()]: Error: " + error, LogLevel.Error);
            throw error;
        }
    }

    /**
     * Find and eeplace ISO 8601 dates in the string by a friendly value
     * @param inputValue The string to format
     */
    private _formatDate(inputValue: string): string {

        const iso8061rgx = /(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))/g;
        const matches = inputValue.match(iso8061rgx);

        let updatedInputValue = inputValue;

        if (matches) {
            matches.map(match => {
                updatedInputValue = updatedInputValue.replace(match, moment(match).format("LL"));
            });
        }

        return updatedInputValue;        
    }

    /**
     * Build the refinement condition in FQL format
     * @param selectedFilters The selected filter array
     */
    private _buildRefinementQueryString(selectedFilters: IRefinementFilter[]): string {
        
        let refinementQueryConditions: string[] = [];
        let refinementQueryString: string = null;
        
        const refinementFilters = mapValues(groupBy(selectedFilters, 'FilterName'), (values) => {
            const refinementFilter =  values.map((filter) => {
                return filter.Value.RefinementToken;                       
            });

            return refinementFilter.length > 1 ? "or(" + refinementFilter + ")" : refinementFilter.toString();
        });
        
        mapKeys(refinementFilters, (value, key) => {
            refinementQueryConditions.push(key + ":" + value);
        });
        
        const conditionsCount = refinementQueryConditions.length;

        switch (true) {
            
            // No filters
            case (conditionsCount === 0): {
                refinementQueryString = null;
                break;
            } 

            // Just one filter
            case (conditionsCount === 1): {
                refinementQueryString = refinementQueryConditions[0].toString();
                break;
            }

            // Multiple filters
            case (conditionsCount > 1): {
                refinementQueryString = "and(" + refinementQueryConditions.toString() + ")";
                break;
            }
        }

        return refinementQueryString;
    }
}

export default SearchDataProvider;